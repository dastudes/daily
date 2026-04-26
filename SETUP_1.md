# Baseball Stats Daily - Setup Guide

This guide will walk you through setting up your daily MLB statistics page on GitHub Pages.

## What You'll Have

- A static HTML page hosted for free on GitHub Pages
- Automatic daily updates at 6 AM EST via GitHub Actions
- Stats from the current MLB season (or previous season if current hasn't started)
- Client-side filtering that users can control

## Step-by-Step Setup

### 1. Create Your GitHub Repository

1. Go to https://github.com and log in
2. Click the "+" icon in the top right, select "New repository"
3. Name it something like `baseball-stats-daily`
4. Make it **Public** (required for free GitHub Pages)
5. Check "Add a README file"
6. Click "Create repository"

### 2. Upload Your Files

You need to upload these 4 files to your repository:

**Files to upload:**
- `.github/workflows/update-stats.yml` (the GitHub Action workflow)
- `generate-stats.js` (the Node.js script that fetches data)
- `package.json` (Node.js dependencies)
- `favicon.png` (your Baseball Graphs favicon - optional)

**How to upload:**

1. In your repository, click "Add file" → "Upload files"
2. For the workflow file:
   - First create the folder structure by clicking "Create new file"
   - Type `.github/workflows/update-stats.yml` in the name field
   - Copy and paste the content from `update-stats.yml`
   - Click "Commit changes"
3. For the other files:
   - Click "Add file" → "Upload files"
   - Drag `generate-stats.js` and `package.json` into the upload area
   - Click "Commit changes"

### 3. Enable GitHub Pages

1. In your repository, click "Settings" (top navigation)
2. Scroll down the left sidebar and click "Pages"
3. Under "Source", select "Deploy from a branch"
4. Under "Branch", select `main` and `/ (root)`
5. Click "Save"

You'll see a message like "Your site is ready to be published at https://[your-username].github.io/baseball-stats-daily/"

### 4. Run the First Build

Your page won't exist yet because the Action hasn't run. Let's trigger it manually:

1. Go to the "Actions" tab in your repository
2. Click on "Update Baseball Stats" in the left sidebar
3. Click "Run workflow" button on the right
4. Click the green "Run workflow" button

This will take 5-10 minutes to complete. You can watch the progress by clicking on the running workflow.

### 5. Check Your Site

Once the workflow completes (green checkmark):

1. Go to `https://[your-username].github.io/baseball-stats-daily/`
2. You should see your stats page!

The page will automatically update every day at 6 AM EST.

## Troubleshooting

### "Workflow requires permission to write to the repository"

If you see this error:

1. Go to Settings → Actions → General
2. Scroll to "Workflow permissions"
3. Select "Read and write permissions"
4. Click "Save"
5. Re-run the workflow

### Stats aren't showing up

- Check the Actions tab to see if the workflow ran successfully
- Click on the failed workflow to see error messages
- Make sure all files are uploaded correctly

### Want to change the update time?

Edit `.github/workflows/update-stats.yml` and change this line:
```yaml
- cron: '0 11 * * *'  # 11 AM UTC = 6 AM EST
```

Use https://crontab.guru/ to generate different times.

### Want to manually trigger an update?

1. Go to Actions tab
2. Click "Update Baseball Stats"
3. Click "Run workflow"

## Customization Options

### Change minimum thresholds defaults

Edit `generate-stats.js` and find these lines:
```javascript
<input type="number" id="minPA" value="0">
<input type="number" id="minIP" value="0">
```

Change the `value="0"` to whatever you want as defaults.

### Change when it checks for new season data

The script automatically detects if the current season has data. If you want to force it to always use the previous year (or current year), edit the `generateHTML()` function in `generate-stats.js`.

## Your Custom Domain (Optional)

If you want to use a custom domain like `stats.baseballgraphs.com`:

1. Add a file named `CNAME` to your repository with just your domain name
2. In your domain's DNS settings, add a CNAME record pointing to `[your-username].github.io`
3. In GitHub Settings → Pages, enter your custom domain

## Need Help?

- Check the Actions tab for error messages
- Look at the workflow run logs for detailed debugging info
- GitHub has great documentation at https://docs.github.com/pages

## How It Works

1. Every day at 6 AM EST, GitHub runs your workflow
2. The workflow installs Node.js and your dependencies
3. It runs `generate-stats.js` which:
   - Checks if the current season has data
   - Falls back to previous season if needed
   - Fetches all rosters and stats from MLB API
   - Generates a complete static HTML file
4. The workflow commits the updated `index.html` back to your repo
5. GitHub Pages automatically publishes the updated file
6. Users see the new stats (no cache issues since the HTML changes)

The page loads instantly because all data is already in the HTML - no API calls needed!
