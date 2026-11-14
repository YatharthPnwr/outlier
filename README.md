# Outlier

A Chrome/Brave extension that sorts any Instagram profile's reels by **Views**, **Likes**, **Comments**, **Outlier score**, or **Oldest** — right on the profile page. Find a creator's best-performing content in one click.

![Panel](https://img.shields.io/badge/manifest-v3-blue) ![No external servers](https://img.shields.io/badge/privacy-no%20external%20servers-brightgreen)

## Features

- **Sort by** Views / Likes / Comments / Outlier score / Oldest
- **Filters**: latest 25 / 50 / 100 / 200 / 1K / All posts, or by date (1 week → 1 year back, custom)
- **Outlier score**: views ÷ the profile's average over the fetched set — `3.2x` means a reel did 3.2× better than the account's average. The signal for what's worth remaking.
- Replaces the profile grid with a ranked grid (#1 = top post, metrics on every tile); one click restores the original feed
- Everything runs in your browser on your own Instagram session. No external servers, no tracking, nothing leaves your machine.

## Install

1. Download this repo: **Code → Download ZIP** and unzip (or `git clone` it).
2. Open `chrome://extensions` (Brave: `brave://extensions`).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** → select the unzipped folder (the one containing `manifest.json`).
5. Open Instagram (must be logged in) and visit any profile.

## Use

1. Go to a profile's **Reels tab** (e.g. `instagram.com/mosseri/reels/`).
2. The **Outlier** panel appears top-right (click the header to collapse/expand).
3. Pick a filter — **Posts** (how many latest posts) or **Date** (how far back).
4. Pick a sort criterion — Likes, Views, Outlier score, Comments, or Oldest.
5. Hit **Sort**. The grid is replaced with the ranked result; tile #1 is the top post. Progress shows while fetching; hitting the button again cancels.
6. Click any tile to open that reel in a new tab. **Restore original feed** brings Instagram's grid back.

### Notes

- Works best on the **Reels tab** (view counts available). The main Posts tab uses an older endpoint that Instagram may block on some sessions.
- Fetched data is cached per profile for the session — re-sorting by a different criterion is instant.
- Requests are throttled (350–750 ms between pages). Large fetches (1K/All) on big accounts take a few minutes. Stick to 25–200 for daily use to stay clear of rate limits.

## How it works

Content script on `instagram.com`, Manifest V3, zero special permissions. It speaks the same GraphQL the Instagram web app itself uses (`PolarisProfileReelsTabContentQuery_connection` against `/api/graphql`), authenticated by your existing session cookies plus the `lsd`/`fb_dtsg` tokens already present in the page. The profile's user id is read from the page's embedded JSON, and post dates are decoded from media ids (Instagram ids encode their creation timestamp). Sorting and rendering are pure DOM — Instagram's grid is hidden, not destroyed.

## Disclaimer

Uses Instagram's private web API, which can change without notice. Heavy use may trigger Instagram rate limits. Use reasonably, at your own risk. Not affiliated with Instagram/Meta.
