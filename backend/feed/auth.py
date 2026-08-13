from django.core.signing import BadSignature, SignatureExpired, TimestampSigner

COOKIE_NAME = "feed_auth"
MAX_AGE = 60 * 60 * 24 * 30  # 30 days

_signer = TimestampSigner(salt="feed-auth")


def make_auth_token():
    return _signer.sign("ok")


def is_valid_token(token):
    if not token:
        return False
    try:
        _signer.unsign(token, max_age=MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False
