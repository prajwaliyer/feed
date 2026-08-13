import re
import time
from datetime import timedelta

import feedparser
import requests
from django.conf import settings
from django.utils import timezone

from . import instagram
from .models import Item, Source

RSS_BATCH_SIZE = 5
ENGAGEMENT_BATCH_SIZE = 10
SOURCE_COOLDOWN_S = 25 * 60

# Instagram story media URLs stop resolving once the story expires (~24h),
# so there's no point keeping the items around much past that.
STORY_RETENTION = timedelta(hours=48)

# Instagram posts are shown unfiltered by the ranking algorithm, so this
# window is the only thing capping how far back they're visible.
POST_RETENTION = timedelta(days=2)

_last_source_fetch = {}


def _extract_tweet_id(url):
    if not url:
        return None
    match = re.search(r"status/(\d+)", url)
    return match.group(1) if match else None


def _fetch_engagement(tweet_id):
    try:
        resp = requests.get(
            f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token=0",
            timeout=5,
        )
        if resp.ok:
            data = resp.json()
            return {
                "likes": data.get("favorite_count", 0),
                "replies": data.get("conversation_count", 0),
            }
    except Exception:
        pass
    return None


def update_engagement():
    pending = Item.objects.filter(like_count__isnull=True).exclude(
        source__type="instagram_story"
    ).values_list("id", "url")
    if not pending:
        return

    print(f"[fetch] Fetching engagement for {len(pending)} items...")

    for item_id, url in pending:
        tweet_id = _extract_tweet_id(url)
        if not tweet_id:
            continue
        eng = _fetch_engagement(tweet_id)
        if eng:
            Item.objects.filter(id=item_id).update(
                like_count=eng["likes"], reply_count=eng["replies"]
            )


def _fetch_rss_source(source, results):
    try:
        feed = feedparser.parse(source.url)
        if feed.bozo and not feed.entries:
            status = feed.get("status", "?")
            print(f"[fetch] Error fetching {source.name}: status={status} bozo={feed.bozo_exception}")
            results["errors"] += 1
            return
    except Exception as e:
        print(f"[fetch] Exception fetching {source.name}: {e}")
        results["errors"] += 1
        return

    for entry in feed.entries:
        guid = getattr(entry, "id", None) or getattr(entry, "link", None) or getattr(entry, "title", "")
        if not guid:
            continue

        content = ""
        if hasattr(entry, "content") and entry.content:
            content = entry.content[0].get("value", "")
        elif hasattr(entry, "summary"):
            content = entry.summary or ""

        img_match = re.search(r'<img[^>]+src="([^"]+)"', content)
        image_url = img_match.group(1) if img_match else None

        link = getattr(entry, "link", None)
        author = getattr(entry, "author", None) or source.name

        published = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            import calendar
            published = timezone.datetime.fromtimestamp(
                calendar.timegm(entry.published_parsed), tz=timezone.utc
            )

        try:
            Item.objects.get_or_create(
                guid=guid,
                defaults={
                    "source": source,
                    "title": getattr(entry, "title", None),
                    "content": content or None,
                    "url": link,
                    "author": author,
                    "image_url": image_url,
                    "published_at": published or timezone.now(),
                    "fetched_at": timezone.now(),
                },
            )
            results["fetched"] += 1
        except Exception:
            pass


def _fetch_instagram_source(source, results):
    try:
        content_items = instagram.fetch_instagram_content(source)
    except instagram.InstagramSessionMissing as e:
        print(f"[fetch] Instagram not configured: {e}")
        results["errors"] += 1
        return
    except Exception as e:
        print(f"[fetch] Exception fetching Instagram content for {source.name}: {e}")
        results["errors"] += 1
        return

    for data in content_items:
        try:
            Item.objects.get_or_create(
                guid=data["guid"],
                defaults={
                    "source": source,
                    "title": data["title"],
                    "content": data["content"],
                    "url": data["url"],
                    "author": data["author"],
                    "image_url": data["image_url"],
                    "published_at": data["published_at"],
                    "fetched_at": timezone.now(),
                    "like_count": data.get("like_count"),
                    "reply_count": data.get("reply_count"),
                },
            )
            results["fetched"] += 1
        except Exception:
            pass


def fetch_all_feeds():
    from .views import set_last_fetch_time

    all_sources = list(Source.objects.all())
    results = {"fetched": 0, "errors": 0, "skipped": 0}

    now = time.time()
    due_sources = [
        s
        for s in all_sources
        if now - _last_source_fetch.get(s.id, 0) >= SOURCE_COOLDOWN_S
    ]

    print(
        f"[fetch] Starting fetch for {len(due_sources)}/{len(all_sources)} sources "
        f"({len(all_sources) - len(due_sources)} in cooldown)..."
    )

    for source in due_sources:
        if source.type == "instagram_story":
            _fetch_instagram_source(source, results)
        else:
            _fetch_rss_source(source, results)
        _last_source_fetch[source.id] = time.time()

    print(f"[fetch] Done ({results['fetched']} new, {results['errors']} errors)")

    update_engagement()

    # Cleanup items older than 3 years
    cutoff = timezone.now() - timedelta(days=3 * 365)
    deleted, _ = Item.objects.filter(published_at__lt=cutoff).delete()
    if deleted:
        print(f"[fetch] Cleaned up {deleted} items older than 3 years")

    # Instagram story media URLs go dead once the story expires, well before
    # the general 3-year retention window, so clean those up separately.
    story_cutoff = timezone.now() - STORY_RETENTION
    deleted_stories, _ = Item.objects.filter(
        source__type="instagram_story",
        guid__startswith="instagram_story_",
        published_at__lt=story_cutoff,
    ).delete()
    if deleted_stories:
        print(f"[fetch] Cleaned up {deleted_stories} expired Instagram stories")

    # Instagram posts are only meant to be visible for POST_RETENTION.
    post_cutoff = timezone.now() - POST_RETENTION
    deleted_posts, _ = Item.objects.filter(
        source__type="instagram_story",
        guid__startswith="instagram_post_",
        published_at__lt=post_cutoff,
    ).delete()
    if deleted_posts:
        print(f"[fetch] Cleaned up {deleted_posts} Instagram posts past the {POST_RETENTION} window")

    set_last_fetch_time(time.time())
    return results
