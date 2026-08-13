import getpass
from pathlib import Path

import instaloader
from django.core.management.base import BaseCommand

SESSION_DIR = Path("/app/data")
SESSION_USERNAME_FILE = SESSION_DIR / "instagram_session_username"


class Command(BaseCommand):
    help = (
        "Log in to Instagram once and save a session file for story fetching. "
        "Run this interactively (docker compose exec feed-backend python manage.py instagram_login) "
        "with the dedicated fetch account, not your main account."
    )

    def handle(self, *args, **options):
        username = input("Instagram username: ").strip()
        password = getpass.getpass("Instagram password: ")

        loader = instaloader.Instaloader(quiet=True)

        try:
            loader.login(username, password)
        except instaloader.TwoFactorAuthRequiredException:
            code = input("2FA code: ").strip()
            loader.two_factor_login(code)

        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        session_path = SESSION_DIR / f"instagram_session_{username}"
        loader.save_session_to_file(str(session_path))
        SESSION_USERNAME_FILE.write_text(username)

        self.stdout.write(self.style.SUCCESS(f"Logged in as {username}, session saved to {session_path}"))
