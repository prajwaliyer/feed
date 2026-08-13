from datetime import datetime, timedelta
from html import escape
from pathlib import Path

import instaloader

SESSION_DIR = Path("/app/data")
SESSION_USERNAME_FILE = SESSION_DIR / "instagram_session_username"

# How far back to pull posts on each fetch. Matches the display/retention
# window in fetcher.py, so we're never fetching posts we'd immediately clean up.
POST_FETCH_WINDOW = timedelta(days=2)

_loader = None


class InstagramSessionMissing(Exception):
    pass


def _get_loader():
    global _loader
    if _loader is not None:
        return _loader

    if not SESSION_USERNAME_FILE.exists():
        raise InstagramSessionMissing(
            "No Instagram session found. Run "
            "`python manage.py instagram_login` once to log in."
        )

    username = SESSION_USERNAME_FILE.read_text().strip()
    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=1,
        quiet=True,
    )
    loader.load_session_from_file(username, str(SESSION_DIR / f"instagram_session_{username}"))
    _loader = loader
    return _loader


def _story_item_to_dict(item):
    if item.is_video and item.video_url:
        content = (
            f'<video controls poster="{item.url}" src="{item.video_url}"></video>'
        )
    else:
        content = f'<img src="{item.url}" />'

    return {
        "guid": f"instagram_story_{item.mediaid}",
        "title": item.caption or None,
        "content": content,
        "url": f"https://www.instagram.com/stories/{item.owner_username}/{item.mediaid}/",
        "author": item.owner_username,
        "image_url": item.url,
        "published_at": item.date_utc,
    }


def _post_item_to_dict(post):
    caption_html = f"<p>{escape(post.caption)}</p>" if post.caption else ""

    media_html = ""
    if post.mediacount > 1:
        for node in post.get_sidecar_nodes():
            if node.is_video and node.video_url:
                media_html += f'<video controls poster="{node.display_url}" src="{node.video_url}"></video>'
            else:
                media_html += f'<img src="{node.display_url}" />'
    elif post.is_video and post.video_url:
        media_html = f'<video controls poster="{post.url}" src="{post.video_url}"></video>'
    else:
        media_html = f'<img src="{post.url}" />'

    return {
        "guid": f"instagram_post_{post.mediaid}",
        "title": None,
        "content": caption_html + media_html,
        "url": f"https://www.instagram.com/p/{post.shortcode}/",
        "author": post.owner_username,
        "image_url": post.url,
        "published_at": post.date_utc,
        "like_count": post.likes,
        # Post.comments falls back to a now-broken metadata endpoint when the
        # count isn't in the lightweight timeline node (which it isn't, for
        # logged-in fetches) - read the iphone-struct field directly instead.
        "reply_count": post._node.get("comments"),
    }


def fetch_instagram_content(source):
    """Fetch current stories and posts from the last POST_FETCH_WINDOW for a
    Source whose name is an Instagram username.

    Stories and posts are fetched independently so a failure in one (e.g. a
    checkpoint challenge on one call) doesn't block the other. Only raises
    if the profile itself can't be resolved (missing session, bad username,
    etc), so the caller can log and skip the whole source.
    """
    loader = _get_loader()
    profile = instaloader.Profile.from_username(loader.context, source.name)

    if profile.profile_pic_url and source.icon_url != profile.profile_pic_url:
        source.icon_url = profile.profile_pic_url
        source.save(update_fields=["icon_url"])

    items = []

    try:
        for story in loader.get_stories(userids=[profile.userid]):
            for item in story.get_items():
                items.append(_story_item_to_dict(item))
    except Exception as e:
        print(f"[instagram] Failed fetching stories for {source.name}: {e}")

    try:
        cutoff = datetime.utcnow() - POST_FETCH_WINDOW
        for post in profile.get_posts():
            if post.date_utc < cutoff:
                break
            items.append(_post_item_to_dict(post))
    except Exception as e:
        print(f"[instagram] Failed fetching posts for {source.name}: {e}")

    return items
