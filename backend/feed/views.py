import json
import re
import statistics
from datetime import timedelta

import requests as http_requests
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from .models import Item, Source

PAGE_SIZE = 20
LIKE_WEIGHT = 1
REPLY_WEIGHT = 27

# In-memory tracking (same as the Node version)
_last_fetch_time = None


def _engagement_score(likes, replies):
    return (likes or 0) * LIKE_WEIGHT + (replies or 0) * REPLY_WEIGHT


def _get_source_median_scores():
    items = Item.objects.filter(like_count__isnull=False).values_list(
        "source_id", "like_count", "reply_count"
    )
    grouped = {}
    for source_id, likes, replies in items:
        score = _engagement_score(likes, replies)
        grouped.setdefault(source_id, []).append(score)

    medians = {}
    for source_id, scores in grouped.items():
        median = statistics.median(scores) if scores else 1
        medians[source_id] = max(median, 1)
    return medians


# --- Items ---


@require_GET
def items_list(request):
    cursor = request.GET.get("cursor")
    source_id = request.GET.get("source")
    starred = request.GET.get("starred")
    min_ratio = request.GET.get("minRatio")

    qs = Item.objects.select_related("source").order_by("-published_at")

    if cursor:
        qs = qs.filter(published_at__lt=cursor)
    if source_id:
        qs = qs.filter(source_id=int(source_id))
    if starred == "true":
        qs = qs.filter(is_starred=True)

    fetch_limit = PAGE_SIZE * 5 if min_ratio else PAGE_SIZE + 1
    results = list(qs[:fetch_limit])

    if min_ratio:
        ratio = float(min_ratio)
        medians = _get_source_median_scores()

        def passes_filter(item):
            median = medians.get(item.source_id, 1)
            score = _engagement_score(item.like_count, item.reply_count)
            multiplier = item.source.custom_multiplier
            boost = float(multiplier) if multiplier else 1
            if boost >= 10:
                return True
            if boost <= 0:
                return False
            effective_ratio = ratio / boost

            followers = item.source.follower_count or 0
            if 0 < followers < 1000:
                effective_ratio *= 0.6
            elif followers < 10000:
                effective_ratio *= 0.8
            elif followers < 100000:
                effective_ratio *= 0.9

            if item.published_at:
                age = timezone.now() - item.published_at
                if age < timedelta(hours=1):
                    effective_ratio *= 0.5

            return score / median >= effective_ratio

        results = [r for r in results if passes_filter(r)]

    has_more = len(results) > PAGE_SIZE
    data = results[:PAGE_SIZE] if has_more else results
    next_cursor = data[-1].published_at.isoformat() if has_more and data else None

    medians = _get_source_median_scores()
    items_out = []
    for item in data:
        d = item.to_dict(source=item.source)
        median = medians.get(item.source_id, 1)
        score = _engagement_score(item.like_count, item.reply_count)
        d["engagementRatio"] = round(score / median, 1)
        items_out.append(d)

    return JsonResponse({"items": items_out, "nextCursor": next_cursor})


@csrf_exempt
@require_http_methods(["PATCH"])
def item_detail(request, item_id):
    body = json.loads(request.body)
    try:
        item = Item.objects.get(id=item_id)
    except Item.DoesNotExist:
        return JsonResponse({"error": "not found"}, status=404)

    updated = False
    if "isRead" in body and isinstance(body["isRead"], bool):
        item.is_read = body["isRead"]
        updated = True
    if "isStarred" in body and isinstance(body["isStarred"], bool):
        item.is_starred = body["isStarred"]
        updated = True

    if not updated:
        return JsonResponse({"error": "No valid fields to update"}, status=400)

    item.save()
    return JsonResponse(item.to_dict())


# --- Sources ---


def _fetch_follower_count(handle):
    try:
        resp = http_requests.get(
            f"https://api.fxtwitter.com/{handle}", timeout=5
        )
        if resp.ok:
            data = resp.json()
            return data.get("user", {}).get("followers")
    except Exception:
        pass
    return None


def _build_rsshub_url(handle):
    clean = handle.lstrip("@")
    return f"{settings.RSSHUB_BASE_URL}/twitter/user/{clean}"


@csrf_exempt
def sources_view(request):
    if request.method == "GET":
        all_sources = Source.objects.all()
        return JsonResponse([s.to_dict() for s in all_sources], safe=False)

    if request.method == "POST":
        body = json.loads(request.body)
        handle = body.get("handle", "").lstrip("@")
        if not handle:
            return JsonResponse({"error": "handle is required"}, status=400)

        source_type = body.get("type", "twitter_user")
        name = body.get("name") or handle
        url = _build_rsshub_url(handle)
        followers = _fetch_follower_count(handle)

        custom_multiplier = body.get("customMultiplier")
        source = Source.objects.create(
            type=source_type,
            name=name,
            url=url,
            icon_url=f"https://unavatar.io/twitter/{handle}",
            follower_count=followers,
            custom_multiplier=str(custom_multiplier) if custom_multiplier is not None else None,
        )
        return JsonResponse(source.to_dict(), status=201)

    if request.method == "PATCH":
        source_id = request.GET.get("id")
        if not source_id:
            return JsonResponse({"error": "id is required"}, status=400)

        body = json.loads(request.body)
        try:
            source = Source.objects.get(id=int(source_id))
        except Source.DoesNotExist:
            return JsonResponse({"error": "not found"}, status=404)

        if "isImportant" in body and isinstance(body["isImportant"], bool):
            source.is_important = body["isImportant"]
        if "customMultiplier" in body:
            val = body["customMultiplier"]
            source.custom_multiplier = str(val) if val is not None else None
        if "priority" in body:
            source.priority = body["priority"]
            source.is_important = body["priority"] == "important"

        source.save()
        return JsonResponse(source.to_dict())

    if request.method == "DELETE":
        source_id = request.GET.get("id")
        if not source_id:
            return JsonResponse({"error": "id is required"}, status=400)
        Source.objects.filter(id=int(source_id)).delete()
        return JsonResponse({"ok": True})

    return JsonResponse({"error": "method not allowed"}, status=405)


# --- Fetch ---


@csrf_exempt
@require_http_methods(["POST"])
def fetch_feeds(request):
    from .fetcher import fetch_all_feeds

    results = fetch_all_feeds()
    return JsonResponse(results)


# --- Last Fetch ---


@require_GET
def last_fetch(request):
    global _last_fetch_time
    return JsonResponse({"lastFetch": _last_fetch_time})


def set_last_fetch_time(ts):
    global _last_fetch_time
    _last_fetch_time = ts


# --- Health ---


@require_GET
def health(request):
    latest = (
        Item.objects.order_by("-fetched_at").values_list("fetched_at", flat=True).first()
    )
    now = timezone.now()
    last = _last_fetch_time

    return JsonResponse({
        "now": now.isoformat(),
        "lastFetchMemory": (
            last if last else "never (server restarted)"
        ),
        "lastFetchDb": latest.isoformat() if latest else "no items",
        "minutesSinceLastFetch": (
            round((now.timestamp() - last) / 60) if last else None
        ) if isinstance(last, (int, float)) else None,
    })


# --- Proxy ---

ALLOWED_HOSTS = [
    "pbs.twimg.com",
    "video.twimg.com",
    "unavatar.io",
    "abs.twimg.com",
]


@require_GET
def proxy(request):
    url = request.GET.get("url")
    if not url:
        return JsonResponse({"error": "url required"}, status=400)

    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
    except Exception:
        return JsonResponse({"error": "invalid url"}, status=400)

    if parsed.hostname not in ALLOWED_HOSTS:
        return JsonResponse({"error": "host not allowed"}, status=403)

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://x.com/",
    }

    range_header = request.META.get("HTTP_RANGE")
    if range_header:
        headers["Range"] = range_header

    try:
        upstream = http_requests.get(url, headers=headers, timeout=15, stream=True)
    except Exception:
        return JsonResponse({"error": "fetch failed"}, status=502)

    if upstream.status_code not in (200, 206):
        return HttpResponse(status=upstream.status_code)

    content = upstream.content
    content_type = upstream.headers.get("Content-Type", "application/octet-stream")

    response = HttpResponse(
        content,
        status=upstream.status_code,
        content_type=content_type,
    )
    response["Content-Length"] = len(content)
    response["Cache-Control"] = "public, max-age=86400, immutable"
    response["Accept-Ranges"] = "bytes"

    content_range = upstream.headers.get("Content-Range")
    if content_range:
        response["Content-Range"] = content_range

    return response


# --- Link Preview ---

_link_preview_cache = {}


@require_GET
def link_preview(request):
    url = request.GET.get("url")
    if not url:
        return JsonResponse({"error": "url required"}, status=400)

    if url in _link_preview_cache:
        return JsonResponse(_link_preview_cache[url])

    try:
        resp = http_requests.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
            },
            timeout=8,
            allow_redirects=True,
        )
        if not resp.ok:
            result = {"url": url, "title": None, "image": None, "domain": None}
            _link_preview_cache[url] = result
            return JsonResponse(result)

        html = resp.text[:50000]

        og_image = re.search(
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            html,
            re.IGNORECASE,
        ) or re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            html,
            re.IGNORECASE,
        )

        og_title = re.search(
            r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
            html,
            re.IGNORECASE,
        ) or re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']',
            html,
            re.IGNORECASE,
        )

        if not og_title:
            og_title = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)

        from urllib.parse import urlparse
        domain = urlparse(url).hostname or ""
        domain = domain.replace("www.", "")

        result = {
            "url": url,
            "title": og_title.group(1).strip() if og_title else None,
            "image": og_image.group(1).strip() if og_image else None,
            "domain": domain,
        }
        _link_preview_cache[url] = result
        return JsonResponse(result)

    except Exception:
        result = {"url": url, "title": None, "image": None, "domain": None}
        _link_preview_cache[url] = result
        return JsonResponse(result)
