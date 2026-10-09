"""Desktop launcher. Edit shared video sources in config/config.py.

main.py starts this same AI pipeline with Flask. Keep source selection in the
shared configuration so the desktop and website cannot select different videos.
"""
from app.pipeline import run as main

if __name__ == "__main__":
    main()
