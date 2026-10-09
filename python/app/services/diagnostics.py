"""Error text that is safe to log: no URL credentials, query strings, or tokens."""

import re

_URL = re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*://)(?:[^/\s@'\"]*@)?"
                  r"(?P<rest>[^\s?#'\"]*)(?:[?#][^\s'\"]*)?")
_BEARER = re.compile(r"(?i)\bbearer\s+\S+")


def redact(text, secrets=(), limit=300):
    """Strip URL user-info, query strings and bearer tokens; then known secrets."""
    text = _URL.sub(r"\g<scheme>\g<rest>", str(text))
    text = _BEARER.sub("Bearer ***", text)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text if len(text) <= limit else text[:limit] + "..."


def describe_error(exc, secrets=()):
    """`ExceptionType: redacted message` for operator logs."""
    message = redact(exc, secrets)
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__
