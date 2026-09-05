@echo off
echo === Installing dependencies for both projects ===

echo.
echo [1/2] Installing Project 1 - TikTok Search Scraper
pip install -r 1_tiktok_search_scraper\requirements.txt

echo.
echo [2/2] Installing Project 2 - Comment Automation
pip install -r 2_comment_automation\requirements.txt

echo.
echo [*] Installing Playwright browsers (Chromium)...
python -m playwright install chromium

echo.
echo [+] Setup complete!
echo.
echo HOW TO USE:
echo   1. Scrape videos:
echo      cd 1_tiktok_search_scraper
echo      python scraper.py --query "your search phrase" --max 50
echo.
echo   2. Automate comments (use the CSV from step 1):
echo      cd ..\2_comment_automation
echo      python automate.py --csv ..\1_tiktok_search_scraper\results\YOUR_FILE.csv
pause
