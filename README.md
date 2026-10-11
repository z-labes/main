# Mick's Picks

Weekly NFL pick'em for family and friends at **mickspicks.me**. Presented by Avari.

- Loads each week's games from ESPN in kickoff order (Thursday, then Sunday, then Monday), with home and away teams, kickoff times and team records.
- People sign up with their first and last name and a 4-number PIN. Mick approves each new person before they show up on the leaderboards.
- Players tap a team for every game and submit. They can change any pick until that game kicks off.
- Picks stay open all week. If someone submits after a game has started, that game counts as a loss for them. Ties count as losses.
- Everyone's picks for a game stay hidden until it kicks off.
- The site has a weekly leaderboard, a season leaderboard, a family leaderboard, a weekly winner banner, a week-by-week history page and an admin page for Mick.

## How the season score works

Everyone starts with 48 pretend games at 24-24. The season score is `(wins + 24) / (games picked + 48)`. That keeps someone who joins late with one hot week from jumping past people who have played all season. To change it, edit `PRIOR_GAMES` in `public/app.js`.

## How it's built

There's no framework and no build step, and it runs on Cloudflare's free tier.

| Path | What it is |
| --- | --- |
| `public/` | The website itself (HTML, CSS, JS and images) |
| `src/worker.js` | The API: sign-up, sign-in, saving picks, standings and admin |
| `src/espn.js` | Fetches schedules and scores from ESPN and caches them |
| `src/schema.js` | Database tables, created automatically on first use |
| `wrangler.jsonc` | Cloudflare configuration |

## One-time setup

### 1. Put the site on Cloudflare
1. Log in at <https://dash.cloudflare.com> and open **Workers & Pages** (under **Compute** in the left sidebar).
2. Click **Create**, then **Import a repository**. Connect your GitHub account when asked and allow access to `z-labes/main`.
3. Pick the `z-labes/main` repository. Set the project name to `mickspicks`, leave the build command blank and keep the deploy command as `npx wrangler deploy`. For the branch, choose the branch that holds this code (`claude/website-creation-3ioffe`, or `main` once it's merged).
4. Click **Deploy**. Cloudflare creates the database automatically. When it finishes you'll get a link like `mickspicks.<you>.workers.dev`, and the site will work there right away.

### 2. Set Mick's admin password
1. In **Workers & Pages**, open **mickspicks**, then **Settings**, then **Variables and Secrets**, and click **Add**.
2. Set the type to **Secret**, the name to `ADMIN_PASSWORD`, and the value to any password Mick will remember. Click **Deploy**.
3. Mick opens the **Mick's admin** link at the bottom of the site and enters that password.

### 3. Connect mickspicks.me from GoDaddy
1. In Cloudflare, click **Add a domain** (on the home page), enter `mickspicks.me` and choose the **Free** plan. Skip any record import. Cloudflare will show you **two nameservers**, like `ada.ns.cloudflare.com`.
2. In GoDaddy, go to **My Products**. Next to `mickspicks.me` click **DNS**, then the **Nameservers** tab, then **Change Nameservers**. Choose **I'll use my own nameservers**, paste in Cloudflare's two nameservers and save. If GoDaddy shows DNSSEC as on, turn it off.
3. Wait until Cloudflare emails you that the domain is **Active**. This usually takes a few minutes but can take a few hours.
4. Back in **Workers & Pages**, open **mickspicks**, then **Settings**, then **Domains & Routes**, then **Add**, then **Custom domain**. Enter `mickspicks.me` and add it. Repeat for `www.mickspicks.me`.

Every push to the connected branch redeploys the site automatically.

## Running it locally

```sh
npm install
echo "ADMIN_PASSWORD=test" > .dev.vars
npm run dev   # http://localhost:8787
```
