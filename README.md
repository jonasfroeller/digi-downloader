# Digi-Downloader

A high-quality book downloader for digi4school.at that preserves vector graphics and generates compact PDF files.

## 🎯 What it does

Downloads digital books from digi4school.at by:
1. Logging into the platform automatically
2. Finding and opening the specified book(s)
3. Extracting each page as SVG (vector graphics)
4. Inlining all assets (images) for offline viewing
5. Generating a combined PDF file

## ✨ Features

- **Vector-based output**: Maintains crisp, scalable graphics
- **Stealth browsing**: Anti-detection to avoid bot blocking
- **Multiple books**: Download single books, lists, or all available
- **Automatic pagination**: Handles multi-page books seamlessly
- **Compact files**: 45MB for 356 pages vs 1GB for rasterized images

## 🤔 Why so complicated?

digi4school.at has bot detection that returns HTTP 450 errors during login if it detects automated behavior. This tool uses:
- `puppeteer-extra-plugin-stealth` to mask automation signatures
- Persistent browser profiles to maintain session state
- Natural timing patterns to mimic human behavior
- Real Chrome browser instead of headless automation

Without these measures, the platform blocks automated access attempts.

## 📋 Prerequisites

- [Bun](https://bun.sh/) runtime
- [Google Chrome](https://www.google.com/chrome/index.html) browser
- digi4school.at account

## 🛠️ Setup

1. Clone and install:
```bash
git clone https://github.com/jonasfroeller/digi-downloader.git
cd digi-downloader
ni
```

2. Create `.env` file:
```env
EMAIL=your.email@example.com
PASSWORD=your_password
BOOK_TITLE=Your Book Title
```

## ⚙️ Configuration

**Book Selection** via `BOOK_TITLE` in `.env`:
- Single title: `BOOK_TITLE=My Book`
- Multiple titles: `BOOK_TITLE=Book A;Book B`
- JSON array: `BOOK_TITLE=["Book A","Book B"]`
- All books: `BOOK_TITLE=null` (downloads everything not yet in `./books`)

**Optional settings**:
```env
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHROME_PROFILE=C:\Users\YourUser\AppData\Local\digi4school-profile
```

## 🚀 Usage

```bash
bun run download.ts
```

Output structure:
```
books/
└── Your Book Title/
    ├── 0001.svg
    ├── 0002.svg
    ├── ...
    └── Your Book Title.pdf
```

## 📄 License

MIT License - Use responsibly and in accordance with digi4school.at Terms of Service and applicable copyright laws.

---

**Note**: Browser stays open for manual verification. Press `Ctrl+C` to quit.
