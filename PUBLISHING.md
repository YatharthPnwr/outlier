# Publishing Outlier to the Chrome Web Store

Everything is prepped — the zip in GitHub Releases is store-ready. These are the steps only the account owner can do.

## 1. Developer account (one-time, $5)

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with your Google account.
3. Pay the one-time **$5** developer registration fee.

## 2. Upload

1. Developer Dashboard → **+ New item**.
2. Upload `outlier-v1.0.0.zip` (from the GitHub release, or run `./build.sh` to regenerate).
3. Fill the **Store listing** tab — ready-made copy below.
4. **Privacy** tab answers below.
5. Submit for review. Review usually takes 1–3 days (sometimes longer for extensions that touch social-media sites).

## 3. Store listing copy (paste-ready)

- **Name**: Outlier
- **Summary** (132 chars max):
  `Sort any Instagram profile's reels by views, likes, comments, or outlier score. Find a creator's best content in one click.`
- **Category**: Social & Communication
- **Description**:

```
Outlier adds a small panel to every Instagram profile that lets you sort a creator's reels by what actually performed:

• Views, Likes, Comments — classic metrics
• Outlier score — views relative to the account's average (3x = a breakout reel)
• Oldest — see how an account started

Pick how many posts to analyse (latest 25 up to all posts, or by date range), hit Sort, and the profile grid is replaced by a ranked grid — #1 is the top reel, each tile shows its metrics, click to open. One click restores the normal feed.

Built for creators and editors studying what works in a niche: find the outliers, understand the hooks, make better content.

Privacy: Outlier runs entirely in your browser on your own Instagram session. It calls the same Instagram endpoints the website itself uses. No external servers, no analytics, no data collection of any kind.
```

- **Screenshots**: 1280×800. Take them on a profile with the sorted grid visible (panel + ranked tiles). At least 1, ideally 3–5.

## 4. Privacy tab answers

- **Single purpose**: Sorting the posts/reels of the Instagram profile the user is viewing by engagement metrics.
- **Host permission justification** (`https://www.instagram.com/*`): The extension's single purpose is to sort content on Instagram profile pages; it needs to run its content script there and call Instagram's own same-origin API with the user's session.
- **Remote code**: No remote code is used or executed.
- **Data usage**: Does not collect, transmit, or sell any user data. All processing is local.

## 5. After approval

The store listing URL will be `https://chromewebstore.google.com/detail/<id>`. Put it at the top of README.md.

## Notes / risks

- Instagram's private web API changes periodically; when sorting breaks, the GraphQL doc_id in `content.js` likely needs re-sniffing (see repo history for how it was captured).
- Chrome Web Store sometimes rejects first submissions of social-media tooling with a template email; respond via the appeal form clarifying the single purpose + no data collection, it generally passes on resubmission.
