import re
import time
from datetime import timedelta

import feedparser
import requests
from django.conf import settings
from django.utils import timezone

from .models import Item, Source

RSS_BATCH_SIZE = 5
ENGAGEMENT_BATCH_SIZE = 10
SOURCE_COOLDOWN_S = 25 * 60

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
    pending = Item.objects.filter(like_count__isnull=True).values_list("id", "url")
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
        f"[fetch] Starting RSS fetch for {len(due_sources)}/{len(all_sources)} sources "
        f"({len(all_sources) - len(due_sources)} in cooldown)..."
    )

    for source in due_sources:
        try:
            feed = feedparser.parse(source.url)
            if feed.bozo and not feed.entries:
                status = feed.get("status", "?")
                print(f"[fetch] Error fetching {source.name}: status={status} bozo={feed.bozo_exception}")
                results["errors"] += 1
                continue
        except Exception as e:
            print(f"[fetch] Exception fetching {source.name}: {e}")
            results["errors"] += 1
            continue

        _last_source_fetch[source.id] = time.time()

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

    print(f"[fetch] RSS done ({results['fetched']} new, {results['errors']} errors)")

    update_engagement()

    # Cleanup items older than 3 years
    cutoff = timezone.now() - timedelta(days=3 * 365)
    deleted, _ = Item.objects.filter(published_at__lt=cutoff).delete()
    if deleted:
        print(f"[fetch] Cleaned up {deleted} items older than 3 years")

    set_last_fetch_time(time.time())
    return results
