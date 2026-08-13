import getpass
from pathlib import Path

import instaloader
from django.core.management.base import BaseCommand

SESSION_DIR = Path("/app/data")
SESSION_USERNAME_FILE = SESSION_DIR / "instagram_session_username"


class Command(BaseCommand):
    help = (
        "Import an Instagram session from browser cookies instead of logging in "
        "with a password. Use this if `instagram_login` hits a checkpoint loop. "
        "Log into Instagram normally in a browser as the dedicated fetch account, "
        "then open devtools -> Application/Storage -> Cookies -> instagram.com "
        "and copy the 'sessionid' and 'csrftoken' cookie values here."
    )

    def handle(self, *args, **options):
        username = input("Instagram username: ").strip()
        sessionid = getpass.getpass("sessionid cookie value: ").strip()
        csrftoken = getpass.getpass("csrftoken cookie value: ").strip()

        if not sessionid or not csrftoken:
            self.stderr.write(self.style.ERROR("Both sessionid and csrftoken are required."))
            return

        loader = instaloader.Instaloader(quiet=True)
        loader.context.load_session(username, {
            "sessionid": sessionid,
            "csrftoken": csrftoken,
            "mid": "",
            "ig_pr": "1",
            "ig_vw": "1920",
        })

        validated_username = loader.test_login()
        if not validated_username:
            self.stderr.write(self.style.ERROR(
                "Cookies didn't validate - session may be expired or malformed. "
                "Re-copy fresh cookie values from the browser and try again."
            ))
            return

        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        session_path = SESSION_DIR / f"instagram_session_{username}"
        loader.save_session_to_file(str(session_path))
        SESSION_USERNAME_FILE.write_text(username)

        self.stdout.write(self.style.SUCCESS(
            f"Session validated as {validated_username}, saved to {session_path}"
        ))
