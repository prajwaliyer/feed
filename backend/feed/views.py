import ipaddress
import json
import re
import socket
import statistics
import threading
import time
from datetime import timedelta
from urllib.parse import urljoin, urlparse

import feedparser
import requests as http_requests
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from . import tts
from .auth import COOKIE_NAME, MAX_AGE, make_auth_token
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

    qs = (
        Item.objects.select_related("source")
        .exclude(guid__startswith="instagram_story_")
        .order_by("-published_at")
    )

    if cursor:
        qs = qs.filter(published_at__lt=cursor)
    if source_id:
        qs = qs.filter(source_id=int(source_id))
    if starred == "true":
        qs = qs.filter(is_starred=True)

    if min_ratio:
        ratio = float(min_ratio)
        medians = _get_source_median_scores()

        def passes_filter(item):
            # Instagram posts aren't ranked by engagement - show all of them
            # (already capped to the last 2 days by fetcher.POST_RETENTION).
            if item.guid.startswith("instagram_post_"):
                return True
            # RSS items never get like/reply counts (those only come from the
            # Twitter syndication API), so they'd always score 0 and vanish
            # from "For You" - show them unfiltered instead.
            if item.source.type == "rss":
                return True

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

        results = []
        batch_size = PAGE_SIZE * 5
        offset = 0
        exhausted = False
        while len(results) < PAGE_SIZE + 1:
            batch = list(qs[offset:offset + batch_size])
            if not batch:
                exhausted = True
                break
            results.extend(item for item in batch if passes_filter(item))
            offset += batch_size

    else:
        results = list(qs[:PAGE_SIZE + 1])
        exhausted = len(results) <= PAGE_SIZE

    has_more = len(results) > PAGE_SIZE and not exhausted
    data = results[:PAGE_SIZE]
    next_cursor = data[-1].published_at.isoformat() if has_more and data else None

    medians = _get_source_median_scores()
    items_out = []
    for item in data:
        d = item.to_dict(source=item.source)
        median = medians.get(item.source_id, 1)
        score = _engagement_score(item.like_count, item.reply_count)
        d["engagementRatio"] = round(score / median, 1)
        d["sourceMultiplier"] = item.source.custom_multiplier
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


# --- Audio narration (Piper TTS) ---

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")

# A long article can take a couple minutes to synthesize on CPU. Holding a
# single HTTP request open that whole time is fragile - it has to survive
# nginx's proxy timeout AND Cloudflare's edge timeout for phone access via
# feed.prajwaliyer.com. So generation runs in a background thread instead;
# the frontend kicks it off then polls a cheap status endpoint, and every
# individual request stays fast regardless of how long synthesis takes.
_generation_lock = threading.Lock()
_generation_status = {}  # item_id -> "generating" | "error"


def _generate_in_background(item_id):
    try:
        item = Item.objects.get(id=item_id)
        tts.synthesize_and_cache(item)
        with _generation_lock:
            _generation_status.pop(item_id, None)
    except Exception as e:
        print(f"[tts] Failed to generate audio for item {item_id}: {e}")
        with _generation_lock:
            _generation_status[item_id] = "error"


@csrf_exempt
@require_http_methods(["POST"])
def item_audio_generate(request, item_id):
    if tts.audio_path(item_id).exists():
        return JsonResponse({"status": "ready"})

    with _generation_lock:
        if _generation_status.get(item_id) == "generating":
            return JsonResponse({"status": "generating"})
        _generation_status[item_id] = "generating"

    if not Item.objects.filter(id=item_id).exists():
        with _generation_lock:
            _generation_status.pop(item_id, None)
        return JsonResponse({"error": "not found"}, status=404)

    threading.Thread(target=_generate_in_background, args=(item_id,), daemon=True).start()
    return JsonResponse({"status": "generating"}, status=202)


@require_GET
def item_audio_status(request, item_id):
    if tts.audio_path(item_id).exists():
        return JsonResponse({"status": "ready"})
    with _generation_lock:
        status = _generation_status.get(item_id)
    return JsonResponse({"status": status or "idle"})


@require_GET
def item_audio(request, item_id):
    path = tts.audio_path(item_id)
    if not path.exists():
        return JsonResponse({"error": "not generated"}, status=404)

    file_size = path.stat().st_size
    range_header = request.META.get("HTTP_RANGE", "")
    range_match = _RANGE_RE.match(range_header)

    if range_match:
        start = int(range_match.group(1)) if range_match.group(1) else 0
        end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
        end = min(end, file_size - 1)
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read(end - start + 1)
        response = HttpResponse(chunk, status=206, content_type="audio/mpeg")
        response["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        response["Content-Length"] = str(len(chunk))
    else:
        response = HttpResponse(path.read_bytes(), content_type="audio/mpeg")
        response["Content-Length"] = str(file_size)

    response["Accept-Ranges"] = "bytes"
    response["Cache-Control"] = "public, max-age=86400, immutable"
    return response


# --- Stories ---

# Instagram stories expire after 24h; their media URLs go dead around then, so
# only surface stories published inside this window in the bubble bar.
STORY_TTL = timedelta(hours=24)

_STORY_VIDEO_SRC_RE = re.compile(r'<video[^>]*\bsrc="([^"]+)"')
_STORY_VIDEO_POSTER_RE = re.compile(r'<video[^>]*\bposter="([^"]+)"')


def _story_item_to_dict(item):
    """Turn a stored instagram_story Item into a viewer-friendly dict.

    The fetcher stores the media as an HTML snippet in `content`
    (<video ... src=.. poster=..> or <img src=..>), so we parse it back out
    here rather than adding columns to the model.
    """
    content = item.content or ""
    video_match = _STORY_VIDEO_SRC_RE.search(content)
    if video_match:
        poster_match = _STORY_VIDEO_POSTER_RE.search(content)
        return {
            "id": item.id,
            "type": "video",
            "videoUrl": video_match.group(1),
            "imageUrl": poster_match.group(1) if poster_match else item.image_url,
            "url": item.url,
            "isRead": item.is_read,
            "publishedAt": item.published_at.isoformat() if item.published_at else None,
        }
    return {
        "id": item.id,
        "type": "image",
        "videoUrl": None,
        "imageUrl": item.image_url,
        "url": item.url,
        "isRead": item.is_read,
        "publishedAt": item.published_at.isoformat() if item.published_at else None,
    }


@require_GET
def stories(request):
    """Active Instagram stories grouped by source, for the bubble bar/viewer.

    Groups are ordered so accounts with unseen stories come first (like
    Instagram), then by most recent. Items within a group play oldest first.
    """
    cutoff = timezone.now() - STORY_TTL
    items = (
        Item.objects.select_related("source")
        .filter(
            source__type="instagram_story",
            guid__startswith="instagram_story_",
            published_at__gte=cutoff,
        )
        .order_by("published_at")
    )

    groups = {}
    for item in items:
        src = item.source
        group = groups.get(src.id)
        if group is None:
            group = {
                "sourceId": src.id,
                "sourceName": src.name,
                "sourceIcon": src.icon_url,
                "items": [],
                "latest": item.published_at,
                "hasUnseen": False,
            }
            groups[src.id] = group
        group["items"].append(_story_item_to_dict(item))
        if item.published_at and item.published_at > group["latest"]:
            group["latest"] = item.published_at
        if not item.is_read:
            group["hasUnseen"] = True

    ordered = sorted(
        groups.values(),
        key=lambda g: (not g["hasUnseen"], -g["latest"].timestamp() if g["latest"] else 0),
    )
    for g in ordered:
        g.pop("latest", None)

    return JsonResponse({"groups": ordered})


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


def _fetch_rss_metadata(url):
    try:
        feed = feedparser.parse(url)
        title = feed.feed.get("title")
        link = feed.feed.get("link") or url
        domain = urlparse(link).netloc
        icon = f"https://www.google.com/s2/favicons?domain={domain}&sz=128" if domain else None
        return title, icon
    except Exception:
        return None, None


@csrf_exempt
def sources_view(request):
    if request.method == "GET":
        all_sources = Source.objects.all()
        return JsonResponse([s.to_dict() for s in all_sources], safe=False)

    if request.method == "POST":
        body = json.loads(request.body)
        source_type = body.get("type", "twitter_user")
        custom_multiplier = body.get("customMultiplier")

        if source_type == "rss":
            feed_url = body.get("url", "").strip()
            if not feed_url:
                return JsonResponse({"error": "url is required"}, status=400)

            title, icon = _fetch_rss_metadata(feed_url)
            name = body.get("name") or title or feed_url
            source = Source.objects.create(
                type=source_type,
                name=name,
                url=feed_url,
                icon_url=icon,
                custom_multiplier=str(custom_multiplier) if custom_multiplier is not None else None,
            )
            return JsonResponse(source.to_dict(), status=201)

        handle = body.get("handle", "").lstrip("@")
        if not handle:
            return JsonResponse({"error": "handle is required"}, status=400)

        name = body.get("name") or handle

        if source_type == "instagram_story":
            source = Source.objects.create(
                type=source_type,
                name=name,
                url=f"https://www.instagram.com/{handle}/",
                icon_url=f"https://unavatar.io/instagram/{handle}",
                custom_multiplier=str(custom_multiplier) if custom_multiplier is not None else None,
            )
            return JsonResponse(source.to_dict(), status=201)

        url = _build_rsshub_url(handle)
        followers = _fetch_follower_count(handle)

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


# --- Auth ---


@csrf_exempt
@require_http_methods(["POST"])
def login(request):
    body = json.loads(request.body)
    username = body.get("username", "")
    password = body.get("password", "")

    if username != settings.AUTH_USERNAME or password != settings.AUTH_PASSWORD:
        return JsonResponse({"error": "Invalid username or password"}, status=401)

    response = JsonResponse({"ok": True})
    response.set_cookie(
        COOKIE_NAME,
        make_auth_token(),
        max_age=MAX_AGE,
        httponly=True,
        samesite="Lax",
    )
    return response


@csrf_exempt
@require_http_methods(["POST"])
def logout(request):
    response = JsonResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME)
    return response


@require_GET
def auth_check(request):
    # LoginRequiredMiddleware already rejects unauthenticated requests before
    # this runs, so simply reaching here means the cookie is valid.
    return JsonResponse({"ok": True})


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

# Instagram CDN hostnames are dynamic per-region/edge (e.g.
# scontent-iad3-1.cdninstagram.com, instagram.fdel1-1.fna.fbcdn.net),
# so these are matched by suffix rather than an exact list.
ALLOWED_HOST_SUFFIXES = [
    ".cdninstagram.com",
    ".fna.fbcdn.net",
]


def _is_public_host(hostname):
    """Resolve hostname and reject anything pointing at a private/internal
    address, so the proxy can't be used to reach the homelab's internal
    network via an attacker-controlled RSS feed's image URLs."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


def _host_allowed(hostname):
    if not hostname:
        return False
    if hostname in ALLOWED_HOSTS:
        return True
    if any(hostname.endswith(suffix) for suffix in ALLOWED_HOST_SUFFIXES):
        return True
    # RSS article images come from arbitrary publisher domains, so fall back
    # to allowing any host that doesn't resolve to an internal address.
    return _is_public_host(hostname)


# Instagram CDN links for expired sessions/stories can hang instead of
# failing fast, and every <img> re-requests the same dead URL on every page
# load. Remember recent failures briefly so repeats fail instantly instead
# of re-waiting on the full timeout.
_proxy_fail_cache = {}
PROXY_FAIL_TTL = 300  # seconds

# unavatar.io rate-limits aggressively, and every avatar <img> across every
# open feed re-fetches it on every load - a handful of sources hitting the
# limit at once was enough to make most avatars fall back to the letter
# placeholder. Avatars barely change, so cache successful responses for
# days rather than re-hitting unavatar.io per view. Scoped to unavatar.io
# only (not twimg.com/cdninstagram.com) since tweet/story media is far
# more numerous and shouldn't be held in memory indefinitely.
_avatar_cache = {}
AVATAR_CACHE_TTL = 60 * 60 * 24 * 3  # 3 days
AVATAR_CACHE_HOSTS = {"unavatar.io"}


@require_GET
def proxy(request):
    url = request.GET.get("url")
    if not url:
        return JsonResponse({"error": "url required"}, status=400)

    try:
        parsed = urlparse(url)
    except Exception:
        return JsonResponse({"error": "invalid url"}, status=400)

    if parsed.scheme not in ("http", "https") or not _host_allowed(parsed.hostname):
        return JsonResponse({"error": "host not allowed"}, status=403)

    range_header = request.META.get("HTTP_RANGE")
    cacheable = parsed.hostname in AVATAR_CACHE_HOSTS and not range_header

    if cacheable:
        cached = _avatar_cache.get(url)
        if cached and time.time() - cached[2] < AVATAR_CACHE_TTL:
            content, content_type, _ = cached
            response = HttpResponse(content, content_type=content_type)
            response["Content-Length"] = len(content)
            response["Cache-Control"] = "public, max-age=86400, immutable"
            return response

    failed_at = _proxy_fail_cache.get(url)
    if failed_at and time.time() - failed_at < PROXY_FAIL_TTL:
        return HttpResponse(status=502)

    is_instagram_cdn = any(parsed.hostname.endswith(suffix) for suffix in ALLOWED_HOST_SUFFIXES)
    is_twitter_cdn = parsed.hostname in ALLOWED_HOSTS
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
    if is_instagram_cdn:
        headers["Referer"] = "https://www.instagram.com/"
    elif is_twitter_cdn:
        headers["Referer"] = "https://x.com/"

    if range_header:
        headers["Range"] = range_header

    try:
        # (connect, read) timeouts - short, since a healthy CDN responds in
        # well under a second; a hung/broken link should fail fast rather
        # than hold the request (and the frontend's fallback UI) for 15s.
        # Redirects are followed manually (rather than via allow_redirects)
        # so each hop's host is re-checked - otherwise a redirect could be
        # used to bypass the private-network check above.
        next_url = url
        upstream = None
        for _ in range(5):
            hop = urlparse(next_url)
            if hop.scheme not in ("http", "https") or not _host_allowed(hop.hostname):
                _proxy_fail_cache[url] = time.time()
                return JsonResponse({"error": "host not allowed"}, status=403)
            resp = http_requests.get(
                next_url, headers=headers, timeout=(4, 6), stream=True, allow_redirects=False
            )
            if resp.is_redirect and resp.headers.get("Location"):
                next_url = urljoin(next_url, resp.headers["Location"])
                continue
            upstream = resp
            break
        if upstream is None:
            _proxy_fail_cache[url] = time.time()
            return JsonResponse({"error": "too many redirects"}, status=502)
    except Exception:
        _proxy_fail_cache[url] = time.time()
        return JsonResponse({"error": "fetch failed"}, status=502)

    if upstream.status_code not in (200, 206):
        _proxy_fail_cache[url] = time.time()
        return HttpResponse(status=upstream.status_code)

    content = upstream.content
    content_type = upstream.headers.get("Content-Type", "application/octet-stream")

    if cacheable and upstream.status_code == 200:
        _avatar_cache[url] = (content, content_type, time.time())

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
