import time

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Fetch all RSS feeds on a loop (every 15 minutes)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--once",
            action="store_true",
            help="Run once and exit instead of looping",
        )
        parser.add_argument(
            "--interval",
            type=int,
            default=900,
            help="Seconds between fetches (default: 900 = 15 min)",
        )

    def handle(self, *args, **options):
        from feed.fetcher import fetch_all_feeds

        if options["once"]:
            self.stdout.write("Running single fetch...")
            results = fetch_all_feeds()
            self.stdout.write(f"Done: {results}")
            return

        interval = options["interval"]
        self.stdout.write(f"Starting fetch loop (every {interval}s)...")

        while True:
            try:
                results = fetch_all_feeds()
                self.stdout.write(
                    f"[{time.strftime('%H:%M:%S')}] "
                    f"Fetched: {results['fetched']}, Errors: {results['errors']}"
                )
            except Exception as e:
                self.stderr.write(f"Error: {e}")

            time.sleep(interval)
