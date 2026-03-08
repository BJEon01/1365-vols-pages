from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import init_db


def main() -> None:
    init_db()
    print("Initialized volunteer_posts schema")


if __name__ == "__main__":
    main()
