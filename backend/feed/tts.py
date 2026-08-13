from pathlib import Path

import requests
from bs4 import BeautifulSoup
from django.conf import settings

# Footnote markers and other reference-only elements read out loud as a
# distracting "...ten hours one!" mid-sentence, so they're dropped before
# building the narration script (the visual reader still shows them, as
# superscript).
NON_SPEECH_SELECTORS = [
    "sup",
    "a.footnote-anchor",
    "[class*=footnote]",
    "[role=doc-noteref]",
    "[aria-hidden=true]",
]
SPEECH_BLOCK_TAGS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figcaption"]

AUDIO_CACHE_DIR = Path(settings.BASE_DIR) / "data" / "audio"


def extract_speech_chunks(html, title=None):
    """Break an item's HTML into paragraph/heading-level text chunks for
    narration. Kept as separate chunks (rather than one joined string) so
    the TTS service can insert a pause between them - Piper's own sentence
    concatenation has no silence at all otherwise."""
    soup = BeautifulSoup(html or "", "html.parser")

    for tag in soup(["script", "style", "button", "svg"]):
        tag.decompose()
    for selector in NON_SPEECH_SELECTORS:
        for el in soup.select(selector):
            el.decompose()

    blocks = soup.find_all(SPEECH_BLOCK_TAGS)
    source = blocks if blocks else [soup]

    chunks = []
    for el in source:
        text = " ".join(el.get_text(" ").split())
        if text:
            chunks.append(text)

    parts = [title.strip()] if title and title.strip() else []
    parts.extend(chunks)
    return parts


def audio_path(item_id):
    return AUDIO_CACHE_DIR / f"{item_id}.mp3"


def synthesize_and_cache(item):
    """Generate narration audio for an item and cache it to disk. Returns
    the cache path. Raises requests.RequestException on TTS service failure."""
    path = audio_path(item.id)
    if path.exists():
        return path

    chunks = extract_speech_chunks(item.content, item.title)
    if not chunks:
        raise ValueError("no readable text for this item")

    # A long article can take over a minute to synthesize on CPU (plus mp3
    # encoding), so the read timeout is generous rather than tuned to the
    # common case.
    resp = requests.post(
        f"{settings.TTS_BASE_URL}/synthesize",
        json={"texts": chunks},
        timeout=(5, 300),
    )
    resp.raise_for_status()

    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".mp3.tmp")
    tmp_path.write_bytes(resp.content)
    tmp_path.rename(path)
    return path
