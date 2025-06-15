# Digi-Downloader

A high-quality book downloader for digi4school.at that preserves vector graphics and generates compact PDF files.

## 🎯 What it does

This tool downloads digital books from digi4school.at by:

1. **Automated Login**: Uses your credentials to log into the platform
2. **Book Navigation**: Finds and opens the specified book in the reader
3. **SVG Extraction**: Downloads each page as an SVG file
4. **Asset Inlining**: Downloads and embeds all referenced images/fonts directly into the SVGs
5. **PDF Generation**: Combines all SVGs into a single, high-quality PDF

## ✨ Key Features

- **Vector-based output**: Maintains crisp, scalable graphics (45MB for 356 pages vs 1GB rasterized)
- **Stealth browsing**: Uses anti-detection techniques to appear as a regular user
- **Asset embedding**: All images and fonts are inlined for offline viewing
- **Automatic pagination**: Handles multi-page books automatically
- **Human-like behavior**: Implements delays and natural navigation patterns

## 🚀 Performance

- **Download speed**: ~249 seconds for 356 pages
- **PDF generation**: ~250 seconds additional processing
- **File size**: Extremely efficient vector-based PDFs (45MB vs 1GB for rasterized)

## 📋 Prerequisites

- [Bun](https://bun.sh/) runtime
- Google Chrome browser
- digi4school.at account

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/jonasfroeller/digi-downloader.git
cd digi-downloader
```

2. Install dependencies:
```bash
ni
```

## ⚙️ Configuration

1. **Environment Variables**: Create a `.env` file:
```env
EMAIL=your.email@example.com
PASSWORD=your_password
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHROME_PROFILE=C:\Users\YourUser\AppData\Local\digi4school-profile
LOCALAPPDATA="C:\Users\YourUser\AppData\Local"
```

2. **Book Selection**: Edit the `BOOK_TITLE` variable in `download.ts`:
```typescript
const BOOK_TITLE = "Your Book Title Here";
```

## 🚀 Usage

Run the downloader:
```bash
bun run download.ts
```

The tool will:
1. Open Chrome and log you into digi4school.at
2. Navigate to your specified book
3. Download all pages as SVG files to `books/[Book Title]/`
4. Generate a PDF file in the same directory
5. Keep the browser open for manual inspection

## 📁 Output Structure

```
books/
└── Your Book Title/
    ├── 0001.svg
    ├── 0002.svg
    ├── ...
    └── Your Book Title.pdf
```

## 🔧 Technical Details

### Dependencies
- **Playwright**: Browser automation with stealth capabilities
- **PDFKit**: PDF generation from SVG sources
- **SVGtoPDF**: Vector-to-PDF conversion library

### Process Flow
1. Launch persistent Chrome context with stealth plugin
2. Authenticate with digi4school.at
3. Navigate to book reader interface
4. Extract SVG URLs for each page
5. Download and process SVGs (inline external assets)
6. Fix SVG compatibility issues (dash arrays, etc.)
7. Generate combined PDF with proper page sizing

### Anti-Detection Features
- Uses `puppeteer-extra-plugin-stealth`
- Persistent browser profile
- Natural timing and navigation patterns
- Realistic user agent and headers

## ⚠️ Legal Notice

This tool is for educational purposes and personal backup of legitimately purchased content. Users are responsible for complying with:
- digi4school.at Terms of Service
- Copyright laws in their jurisdiction
- Educational licensing agreements

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (feat/your-feature, bug/your-bugfix)
3. Make your changes
4. Submit a pull request

## 📄 License

This project is open source. Please use responsibly and in accordance with applicable laws and terms of service.

---

**Note**: This tool maintains the browser session for manual verification. Press `Ctrl+C` to quit when finished.
