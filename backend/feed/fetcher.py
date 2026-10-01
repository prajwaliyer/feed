import json
import os
import re
import time
from datetime import timedelta

import feedparser
import requests
from django.conf import settings
from django.db.models import F, Q
from django.utils import timezone

from . import instagram
from .models import Item, Setting, Source

RSS_BATCH_SIZE = 5
ENGAGEMENT_BATCH_SIZE = 10

# The "is this source due?" filter. It must stay BELOW the interval passed to
# `manage.py fetchfeeds`, because the shortest gap between two passes for a
# given source is exactly that interval - a source fetched at the end of pass N
# with pass N+1 starting `interval` seconds later. Set it higher and the tail of
# every pass silently drops out of the next one. It used to be 25 min pressed
# against a 30 min sleep, which guaranteed every source was due on every pass;
# that is what pinned the same accounts into starvation instead of rotating
# which ones missed out.
SOURCE_COOLDOWN_S = 30

# Every twitter_user source is served by RSSHub, which fetches them all using a
# pool of Twitter auth tokens. Twitter rate-limits the timeline endpoint per
# token and RSSHub reacts by locking that token for ~2000s. Firing all ~99
# sources back-to-back burned the whole per-window budget in about 40 seconds,
# so the lock always landed at the same point in the cycle and the same ~37
# accounts came back empty every time. Spacing the requests out keeps each
# window's burst inside the budget so the lock never trips in the first place.
#
# RSSHub's locks are per-token (`twitter:lock-token1:<token>`) and it rotates
# the pool round-robin, so N tokens buy N times the budget and the safe spacing
# drops to 25/N. Derived from the pool rather than hardcoded, so adding an
# account to TWITTER_AUTH_TOKEN retunes this automatically instead of leaving a
# stale number behind. Floored at 3s because RSSHub caches timelines for
# CACHE_EXPIRE=300 - any faster and it just re-reads cache. An explicit
# RSSHUB_MIN_INTERVAL_S in the environment still wins.
_RSSHUB_BASE_INTERVAL_S = 25
_RSSHUB_MIN_INTERVAL_FLOOR_S = 3


def _twitter_token_count():
    """How many distinct tokens RSSHub has to rotate over (never below 1)."""
    raw = os.environ.get("TWITTER_AUTH_TOKEN", "")
    return max(len([t for t in raw.split(",") if t.strip()]), 1)


def _rsshub_min_interval_s():
    override = os.environ.get("RSSHUB_MIN_INTERVAL_S")
    if override:
        return int(override)
    return max(
        _RSSHUB_MIN_INTERVAL_FLOOR_S,
        _RSSHUB_BASE_INTERVAL_S // _twitter_token_count(),
    )


RSSHUB_MIN_INTERVAL_S = _rsshub_min_interval_s()

# An empty feed from RSSHub means the token is locked, not that the account has
# no posts. Each such request costs ~45s of retry spinning inside RSSHub, so
# after a few in a row, stop asking and let the remaining sources lead the next
# cycle instead of burning the whole cycle on requests that cannot succeed.
RSSHUB_LOCK_THRESHOLD = 3

# Sources are served oldest-fetch-first, so anything that gets deferred (or
# starved) moves to the front of the next cycle rather than waiting behind the
# same wall forever. Kept in the DB because the in-memory map resets on restart.
LAST_ATTEMPT_KEY = "source_last_attempt"

# Instagram's web_profile_info endpoint has been rate-limiting us (429) on
# every fetch at the default cadence, so poll it much less often.
INSTAGRAM_COOLDOWN_S = 2 * 60 * 60

# Firing all due Instagram sources back-to-back in one cycle looks bursty to
# Instagram and gets the whole session 429'd, so space them out too.
INSTAGRAM_SOURCE_DELAY_S = 30

# The session has been 429'd solid since 2026-08-13, including after waiting
# a month and after routing through a NordVPN exit IP via gluetun (still
# 429'd instantly) - so this is an account-level block on the session, not
# an IP rate limit. Nothing short of a long cooldown or a new account fixes
# that. Paused for a month from 2026-08-18 to let it clear.
INSTAGRAM_PAUSED_UNTIL = timezone.datetime(2026, 9, 18, 0, 0, tzinfo=timezone.utc)

# Instagram story media URLs stop resolving once the story expires (~24h),
# so there's no point keeping the items around much past that.
STORY_RETENTION = timedelta(hours=48)

# Instagram posts are shown unfiltered by the ranking algorithm, so this
# window is the only thing capping how far back they're visible.
POST_RETENTION = timedelta(days=2)

# --- Engagement sampling ---
#
# Likes and replies come from Twitter's syndication endpoint, which serves
# current numbers for a tweet. Reading each item once, minutes after it arrived,
# froze its score at whatever it had at a minute old - so anything that took off
# hours later was ranked as a flop forever and could never reach the For You
# feed. Recent items are re-sampled on a rolling window instead.
ENGAGEMENT_WINDOW = timedelta(hours=48)

# How long one sample stands before it is read again. Short enough to notice a
# post taking off, long enough to stay cheap: the window holds ~1700 items, so
# at 2h each pass re-reads roughly 660 of them rather than all 1700.
ENGAGEMENT_STALENESS = timedelta(hours=2)

# Ceiling on reads per pass, so a cold start (every item unsampled) can't stretch
# the pass past the interval it runs on.
ENGAGEMENT_BATCH = 800

# The bar the For You feed ranks against - the frontend sends minRatio=3 - applied
# server-side to decide what has earned a trip back to the top.
PROMOTE_RATIO = 3.0

# Only promote items that have already drifted down: anything on the first page
# is visible anyway, and re-stamping it would churn positions for nothing.
PROMOTE_MIN_AGE = timedelta(hours=6)

# Cap per pass, so a burst of qualifying posts can't slam a solid block onto the
# top of the feed. Highest ratio wins when more than this qualify.
PROMOTE_BATCH = 25

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


def _promote_blooming(now):
    """Float posts that crossed the For You bar late back to the top, once.

    Re-sampling counts fixes a late bloomer's *score*, but the feed is ordered by
    position stamp and an item's stamp is fixed when it arrives - so on its own
    that just re-scores a post sitting on page 15, where nobody sees it. Clearing
    the bar earns one trip back to the top. `promoted_at` makes it one-shot: the
    age gate alone would let the same post be promoted again every 6h, pinning it
    to the top for as long as the engagement holds.
    """
    from .views import _engagement_score, _get_source_median_scores

    medians = _get_source_median_scores()
    candidates = (
        Item.objects.filter(
            promoted_at__isnull=True,
            like_count__isnull=False,
            fetched_at__lt=now - PROMOTE_MIN_AGE,
            published_at__gte=now - ENGAGEMENT_WINDOW,
        )
        .exclude(source__type="instagram_story")
        .select_related("source")
    )

    scored = []
    for item in candidates:
        boost = float(item.source.custom_multiplier or 1)
        # Muted sources stay muted. A 10x source already bypasses the For You
        # filter - every post of its is on show regardless of score - so promoting
        # would only shove its older posts above newer ones from the same account.
        if boost <= 0 or boost >= 10:
            continue
        median = medians.get(item.source_id, 1)
        ratio = _engagement_score(item.like_count, item.reply_count) / median
        if ratio >= PROMOTE_RATIO:
            scored.append((ratio, item.id))

    if not scored:
        return

    scored.sort(reverse=True)
    ids = [item_id for _, item_id in scored[:PROMOTE_BATCH]]
    Item.objects.filter(id__in=ids).update(fetched_at=now, promoted_at=now)
    print(
        f"[fetch] Promoted {len(ids)} late-blooming post(s) to the top "
        f"({len(scored)} cleared the bar)"
    )


def update_engagement():
    now = timezone.now()

    # Recent items whose counts are missing or past their staleness window,
    # stalest first - so the samples most out of date are the ones refreshed.
    pending = list(
        Item.objects.filter(published_at__gte=now - ENGAGEMENT_WINDOW)
        .exclude(source__type="instagram_story")
        .filter(
            Q(engagement_checked_at__isnull=True)
            | Q(engagement_checked_at__lt=now - ENGAGEMENT_STALENESS)
        )
        .order_by("engagement_checked_at", "id")
        .values_list("id", "url")[:ENGAGEMENT_BATCH]
    )
    if not pending:
        return

    print(f"[fetch] Sampling engagement for {len(pending)} items...")

    for item_id, url in pending:
        tweet_id = _extract_tweet_id(url)
        eng = _fetch_engagement(tweet_id) if tweet_id else None
        # Stamp every item looked at, not just the ones that yielded numbers.
        # RSS and Instagram items have no tweet id and would otherwise stay
        # permanently unsampled, refilling the batch every pass so that nothing
        # else ever got refreshed.
        fields = {"engagement_checked_at": timezone.now()}
        if eng:
            fields["like_count"] = eng["likes"]
            fields["reply_count"] = eng["replies"]
        Item.objects.filter(id=item_id).update(**fields)

    _promote_blooming(now)


def _place_backfilled_history(backfilling, created_ids):
    """Put a source's first-ever fetch where its posts belong in time.

    The first time we store anything for a source, everything it returns is
    history rather than news - RSSHub hands over the account's last ~20 posts,
    an RSS feed its last 10-50 entries. Stamped with `now`, that history becomes
    a solid block at the top of the feed (a full page per source, because a
    source's items are inserted back to back and so get consecutive fetch
    times), and the real timeline is pushed off the first pages. That is exactly
    what happened the day the starved accounts started delivering again: 304
    items, 15 pages of week-old catch-up, sitting above everything current.

    So a first-ever fetch keeps its published position, and only genuinely new
    posts from a source we already know about count as news and go to the top on
    fetch time. This also means adding an account no longer floods the feed with
    its back-catalogue.

    Bulk UPDATE rather than setting the column at insert time because
    `fetched_at` is `auto_now_add`, which overwrites whatever is passed in.
    """
    if not (backfilling and created_ids):
        return
    # published_at is nullable; copying NULL into a NOT NULL column would fail.
    Item.objects.filter(pk__in=created_ids, published_at__isnull=False).update(
        fetched_at=F("published_at")
    )


def _fetch_rss_source(source, results):
    """Fetch one RSS-backed source. Returns "ok", "empty" or "error".

    "empty" is the interesting one: RSSHub answers HTTP 200 with a perfectly
    valid feed wrapper and zero <item>s when its Twitter token is unavailable
    (the route sets allowEmpty), so it looks exactly like a success that simply
    had no new posts. Without this check the whole starvation was invisible.
    """
    try:
        feed = feedparser.parse(source.url)
        if feed.bozo and not feed.entries:
            status = feed.get("status", "?")
            print(f"[fetch] Error fetching {source.name}: status={status} bozo={feed.bozo_exception}")
            results["errors"] += 1
            return "error"
    except Exception as e:
        print(f"[fetch] Exception fetching {source.name}: {e}")
        results["errors"] += 1
        return "error"

    if not feed.entries:
        print(f"[fetch] Empty feed for {source.name} ({source.url}) - source is publishing nothing")
        results["errors"] += 1
        results["empty"] += 1
        return "empty"

    # Read up front: the moment the first item is stored this source stops
    # being "new", and every later item in this same fetch would be treated as
    # news and pushed to the top instead of being backfilled with it.
    backfilling = not Item.objects.filter(source_id=source.id).exists()
    created_ids = []

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
            obj, created = Item.objects.get_or_create(
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
            # Only genuinely new items, so the log line means something.
            if created:
                results["fetched"] += 1
                created_ids.append(obj.pk)
        except Exception:
            pass

    _place_backfilled_history(backfilling, created_ids)
    return "ok"


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

    # Same first-ever-fetch rule as the RSS path.
    backfilling = not Item.objects.filter(source_id=source.id).exists()
    created_ids = []

    for data in content_items:
        try:
            obj, created = Item.objects.get_or_create(
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
            # Only genuinely new items - this used to count every entry handed
            # back, already-stored ones included, so the run log overstated it.
            if created:
                results["fetched"] += 1
                created_ids.append(obj.pk)
        except Exception:
            pass

    _place_backfilled_history(backfilling, created_ids)


def _is_twitter_source(source):
    """Sources served by RSSHub's twitter route, which share one token budget."""
    return source.type == "twitter_user" or "/twitter/" in (source.url or "")


def _load_last_attempts():
    try:
        return json.loads(Setting.objects.get(key=LAST_ATTEMPT_KEY).value)
    except (Setting.DoesNotExist, ValueError):
        pass

    # Nothing stored yet (first run after this change, or a fresh DB). Seed from
    # when each source last actually produced an item, so the accounts that have
    # been starved the longest lead the very first cycle instead of waiting.
    from django.db.models import Max

    seeded = {}
    for row in Item.objects.values("source_id").annotate(last=Max("fetched_at")):
        if row["last"]:
            seeded[str(row["source_id"])] = row["last"].timestamp()
    return seeded


def _save_last_attempts(attempts):
    try:
        Setting.objects.update_or_create(
            key=LAST_ATTEMPT_KEY, defaults={"value": json.dumps(attempts)}
        )
    except Exception as e:
        print(f"[fetch] Could not persist last-attempt times: {e}")


def fetch_all_feeds():
    from .views import set_last_fetch_time

    all_sources = list(Source.objects.all())
    results = {"fetched": 0, "errors": 0, "skipped": 0, "empty": 0}

    instagram_paused = timezone.now() < INSTAGRAM_PAUSED_UNTIL

    now = time.time()
    due_sources = [
        s
        for s in all_sources
        if not (instagram_paused and s.type == "instagram_story")
        and now - _last_source_fetch.get(s.id, 0)
        >= (INSTAGRAM_COOLDOWN_S if s.type == "instagram_story" else SOURCE_COOLDOWN_S)
    ]

    # Oldest-fetch-first. A source that gets deferred or starved this cycle leads
    # the next one, so a bad window rotates which accounts miss out instead of
    # pinning the same ones forever.
    attempts = _load_last_attempts()
    due_sources.sort(key=lambda s: attempts.get(str(s.id), 0))

    print(
        f"[fetch] Starting fetch for {len(due_sources)}/{len(all_sources)} sources "
        f"({len(all_sources) - len(due_sources)} in cooldown), "
        f"twitter pacing {RSSHUB_MIN_INTERVAL_S}s over "
        f"{_twitter_token_count()} token(s)..."
    )
    if instagram_paused:
        print(f"[fetch] Instagram paused until {INSTAGRAM_PAUSED_UNTIL.isoformat()}")

    fetched_instagram = False
    last_rsshub_request = 0.0
    rsshub_empty_streak = 0
    rsshub_down = False

    for source in due_sources:
        if source.type == "instagram_story":
            if fetched_instagram:
                time.sleep(INSTAGRAM_SOURCE_DELAY_S)
            _fetch_instagram_source(source, results)
            fetched_instagram = True
        elif _is_twitter_source(source):
            if rsshub_down:
                # The token is locked, so every request would burn ~45s in
                # RSSHub's retry loop and still come back empty. Leave these
                # sources due (and oldest-first) so they lead the next cycle.
                results["skipped"] += 1
                continue
            gap = time.time() - last_rsshub_request
            if gap < RSSHUB_MIN_INTERVAL_S:
                time.sleep(RSSHUB_MIN_INTERVAL_S - gap)
            last_rsshub_request = time.time()
            status = _fetch_rss_source(source, results)
            if status == "empty":
                rsshub_empty_streak += 1
                if rsshub_empty_streak >= RSSHUB_LOCK_THRESHOLD:
                    print(
                        f"[fetch] {rsshub_empty_streak} empty twitter feeds in a row - RSSHub "
                        "token is rate-limited/locked, deferring the rest of this cycle"
                    )
                    rsshub_down = True
            else:
                rsshub_empty_streak = 0
        else:
            _fetch_rss_source(source, results)

        _last_source_fetch[source.id] = time.time()
        attempts[str(source.id)] = time.time()

    if results["skipped"]:
        print(f"[fetch] Deferred {results['skipped']} RSSHub sources; they lead the next cycle")

    print(
        f"[fetch] Done ({results['fetched']} new, {results['errors']} errors, "
        f"{results['empty']} empty)"
    )

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
