from django.http import JsonResponse

from .auth import COOKIE_NAME, is_valid_token

EXEMPT_PATHS = {"/api/login"}


class LoginRequiredMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/api/") and request.path not in EXEMPT_PATHS:
            if not is_valid_token(request.COOKIES.get(COOKIE_NAME)):
                return JsonResponse({"error": "unauthorized"}, status=401)
        return self.get_response(request)
