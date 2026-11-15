import Foundation
import Capacitor
import UIKit
import WebKit
import AVFoundation

/**
 * In-app browser of the WebTrad iPhone app.
 *
 * Websites behind an anti-bot wall (Cloudflare…) turn away the relays the web
 * version reads pages through, but open normally in a real browser. Here the
 * reader browses to a chapter, taps "Get pages", and the app reads the image
 * addresses of the page on screen, then downloads them with the browser's own
 * session (cookies, user agent, referer), as the page itself would.
 *
 * JavaScript API (src/lib/native.ts):
 *   open({ url?, labels, auto? }) -> { cancelled: true } | { images, title, page, next }
 *     auto: the page is opened behind a progress card and its images are taken
 *     as soon as they show up (paste a link and read). The browser itself only
 *     appears when the website asks for a check the reader has to tap.
 *   download({ urls, referer }) -> { files: [{ url, path }], failed }
 *   event "progress" { done, total } while downloading
 *   keepAlive({ on }) -> {}: while a chapter is being translated, the app
 *     keeps running when the reader leaves it or locks the phone (see below).
 */
@objc(WebTradBrowserPlugin)
public class WebTradBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebTradBrowserPlugin"
    public let jsName = "WebTradBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readClipboard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "otherAudio", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - Working in the background

    /// Silence played in a loop: iOS lets an app that plays audio run while
    /// it is in the background (Info.plist: UIBackgroundModes = audio). Mixed
    /// with other sounds, so the reader's music is not interrupted.
    private var silence: AVAudioPlayer?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var keepingAlive = false
    private var observers: [NSObjectProtocol] = []

    /// Whether another app (Safari's video, YouTube, music…) is playing sound:
    /// the page then must not start its own audio, which would cut it.
    @objc func otherAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let session = AVAudioSession.sharedInstance()
            call.resolve(["playing": session.isOtherAudioPlaying || session.secondaryAudioShouldBeSilencedHint])
        }
    }

    @objc func keepAlive(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            if on { self.startKeepingAlive() } else { self.stopKeepingAlive() }
            call.resolve()
        }
    }

    private func startKeepingAlive() {
        guard !keepingAlive else { return }
        keepingAlive = true
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
        if silence == nil {
            silence = try? AVAudioPlayer(data: Self.silentWav())
            silence?.numberOfLoops = -1
            silence?.volume = 0.01
        }
        silence?.play()
        let center = NotificationCenter.default
        // Another app starting a video or music (YouTube, Netflix, Spotify…)
        // interrupts the loop, and iOS would then suspend the app within
        // seconds. The session mixes with others, so it can be activated
        // again while the other app plays: it is, right away and every few
        // seconds until the loop runs, without stopping the other app.
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            self?.resumeSilence()
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.silence = nil
            self?.resumeSilence()
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.resumeSilence()
        })
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self = self, self.keepingAlive, self.silence?.isPlaying != true else { return }
            self.resumeSilence()
        }
        // Extra time asked to iOS when the app leaves the screen, in case the audio is refused.
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.keepingAlive, self.backgroundTask == .invalid else { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "WebTrad translation") { [weak self] in
                self?.endBackgroundTask()
            }
            self.silence?.play()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.endBackgroundTask()
        })
    }

    /// Plays the silence again (mixed with whatever else is playing).
    private func resumeSilence() {
        guard keepingAlive else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
        if silence == nil {
            silence = try? AVAudioPlayer(data: Self.silentWav())
            silence?.numberOfLoops = -1
            silence?.volume = 0.01
        }
        if silence?.isPlaying != true { silence?.play() }
    }

    private var watchdog: Timer?

    private func stopKeepingAlive() {
        guard keepingAlive else { return }
        keepingAlive = false
        watchdog?.invalidate()
        watchdog = nil
        silence?.stop()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        endBackgroundTask()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    /// One second of silence, as a WAV file (8 kHz, 8-bit mono).
    private static func silentWav() -> Data {
        let rate: UInt32 = 8000
        let samples = Int(rate)
        var data = Data()
        func add<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); add(UInt32(36 + samples).littleEndian)
        data.append(contentsOf: Array("WAVE".utf8)); data.append(contentsOf: Array("fmt ".utf8))
        add(UInt32(16).littleEndian); add(UInt16(1).littleEndian); add(UInt16(1).littleEndian)
        add(rate.littleEndian); add(rate.littleEndian); add(UInt16(1).littleEndian); add(UInt16(8).littleEndian)
        data.append(contentsOf: Array("data".utf8)); add(UInt32(samples).littleEndian)
        // 8-bit PCM: 128 is the zero level.
        data.append(contentsOf: [UInt8](repeating: 128, count: samples))
        return data
    }

    /// Private browsing: cookies, cache and site storage of the in-app browser
    /// live in memory only, for as long as the app runs (an anti-bot check is
    /// passed once per session), and nothing is written to the phone.
    static let privateStore: WKWebsiteDataStore = WKWebsiteDataStore.nonPersistent()
    private static var cleanedOldData = false

    override public func load() {
        super.load()
        Self.forgetOldBrowsing()
    }

    /// Earlier versions browsed with the persistent store: what websites left
    /// there (cookies, cache, storage) is deleted. The app's own data (its
    /// library, served from "localhost") is kept.
    private static func forgetOldBrowsing() {
        guard !cleanedOldData else { return }
        cleanedOldData = true
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default()
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            store.fetchDataRecords(ofTypes: types) { records in
                let sites = records.filter { !["localhost", "127.0.0.1", ""].contains($0.displayName) }
                if !sites.isEmpty { store.removeData(ofTypes: types, for: sites) {} }
            }
        }
    }

    /// User agent of the in-app browser, sent with the image downloads.
    private var userAgent: String?

    @objc func open(_ call: CAPPluginCall) {
        let start = call.getString("url").flatMap { URL(string: $0) }
        let auto = call.getBool("auto") ?? false
        var labels: [String: String] = [:]
        for (key, value) in call.getObject("labels") ?? [:] {
            if let text = value as? String { labels[key] = text }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else {
                call.reject("No view controller")
                return
            }
            let browser = BrowserViewController(start: start, labels: labels, auto: auto && start != nil) { [weak self] result, agent in
                if let agent = agent { self?.userAgent = agent }
                if let result = result {
                    call.resolve(result)
                } else {
                    call.resolve(["cancelled": true])
                }
            }
            let navigation = UINavigationController(rootViewController: browser)
            navigation.modalPresentationStyle = .fullScreen
            presenter.present(navigation, animated: true)
        }
    }

    /// Text of the clipboard, read natively: iOS then asks once ("Allow Paste")
    /// and the reader can allow it for good in Settings › WebTrad, instead of
    /// the web view's "Paste" bubble at every tap.
    @objc func readClipboard(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["text": UIPasteboard.general.string ?? ""])
        }
    }

    @objc func download(_ call: CAPPluginCall) {
        let urls = (call.getArray("urls") ?? []).compactMap { ($0 as? String).flatMap { URL(string: $0) } }
        let referer = call.getString("referer")
        if urls.isEmpty {
            call.resolve(["files": [], "failed": 0])
            return
        }
        // The cookies of the in-app browser (Cloudflare clearance included) go with the requests.
        DispatchQueue.main.async {
            Self.privateStore.httpCookieStore.getAllCookies { cookies in
                Task {
                    let result = await self.fetchAll(urls: urls, referer: referer, cookies: cookies)
                    call.resolve(result)
                }
            }
        }
    }

    /// Downloads keep nothing either: no shared cookie jar, no disk cache.
    private static let downloads = URLSession(configuration: .ephemeral)

    private func fetchAll(urls: [URL], referer: String?, cookies: [HTTPCookie]) async -> [String: Any] {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("webtrad-import", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let total = urls.count
        var paths = [String?](repeating: nil, count: total)
        var done = 0
        let agent = userAgent
        await withTaskGroup(of: (Int, String?).self) { group in
            var next = 0
            // Four downloads at a time, like the web version.
            func addTask() {
                guard next < total else { return }
                let index = next
                let url = urls[index]
                next += 1
                group.addTask {
                    let path = await WebTradBrowserPlugin.fetchOne(url: url, index: index, folder: folder, referer: referer, cookies: cookies, agent: agent)
                    return (index, path)
                }
            }
            for _ in 0..<min(4, total) { addTask() }
            while let (index, path) = await group.next() {
                paths[index] = path
                done += 1
                notifyListeners("progress", data: ["done": done, "total": total])
                addTask()
            }
        }
        var files: [[String: String]] = []
        for (index, path) in paths.enumerated() {
            if let path = path { files.append(["url": urls[index].absoluteString, "path": path]) }
        }
        return ["files": files, "failed": total - files.count]
    }

    private static func fetchOne(url: URL, index: Int, folder: URL, referer: String?, cookies: [HTTPCookie], agent: String?) async -> String? {
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.setValue("image/avif,image/webp,image/apng,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
        if let referer = referer { request.setValue(referer, forHTTPHeaderField: "Referer") }
        if let agent = agent { request.setValue(agent, forHTTPHeaderField: "User-Agent") }
        let host = url.host ?? ""
        let matching = cookies.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return host == domain || host.hasSuffix("." + domain)
        }
        for (name, value) in HTTPCookie.requestHeaderFields(with: matching) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        do {
            let (data, response) = try await Self.downloads.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else { return nil }
            let mime = http.mimeType ?? ""
            if !mime.hasPrefix("image/") && mime != "application/octet-stream" && mime != "binary/octet-stream" { return nil }
            let ext: String
            switch mime {
            case "image/png": ext = "png"
            case "image/webp": ext = "webp"
            case "image/gif": ext = "gif"
            case "image/avif": ext = "avif"
            default: ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension.lowercased()
            }
            let file = folder.appendingPathComponent(String(format: "%03d.%@", index + 1, ext))
            try data.write(to: file)
            return file.absoluteString
        } catch {
            return nil
        }
    }
}

/// Full-screen browser: address bar, back / forward / reload and "Get pages".
final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UITextFieldDelegate {
    private static let lastUrlKey = "webtrad.browser.lastUrl"

    private let start: URL?
    private let labels: [String: String]
    /// Waiting for the images on its own (see `probe`).
    private var auto: Bool
    private var probing = false
    private var probeTimer: Timer?
    private var giveUpTimer: Timer?
    private let overlay = UIView()
    private let overlayLabel = UILabel()
    private let completion: ([String: Any]?, String?) -> Void
    private var finished = false

    private var webView: WKWebView!
    private let address = UITextField()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var progressObservation: NSKeyValueObservation?
    private var backItem: UIBarButtonItem!
    private var forwardItem: UIBarButtonItem!
    private var grabItem: UIBarButtonItem!

    init(start: URL?, labels: [String: String], auto: Bool, completion: @escaping ([String: Any]?, String?) -> Void) {
        self.start = start
        self.labels = labels
        self.auto = auto
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    private func label(_ key: String, _ fallback: String) -> String {
        return labels[key] ?? fallback
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let configuration = WKWebViewConfiguration()
        // Private browsing: nothing kept on the phone once the app is closed.
        configuration.websiteDataStore = WebTradBrowserPlugin.privateStore
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progress)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            guard let self = self else { return }
            self.progress.progress = Float(web.estimatedProgress)
            self.progress.isHidden = web.estimatedProgress >= 1
        }

        address.placeholder = label("address", "Address of the chapter")
        address.borderStyle = .roundedRect
        address.keyboardType = .URL
        address.autocapitalizationType = .none
        address.autocorrectionType = .no
        address.returnKeyType = .go
        address.clearButtonMode = .whileEditing
        address.delegate = self
        address.font = .systemFont(ofSize: 15)
        address.frame = CGRect(x: 0, y: 0, width: 1000, height: 34)
        navigationItem.titleView = address
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: label("close", "Close"), style: .plain, target: self, action: #selector(close))

        backItem = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), style: .plain, target: self, action: #selector(goBack))
        forwardItem = UIBarButtonItem(image: UIImage(systemName: "chevron.forward"), style: .plain, target: self, action: #selector(goForward))
        let reload = UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reloadPage))
        grabItem = UIBarButtonItem(title: label("grab", "Get pages"), style: .done, target: self, action: #selector(grab))
        let space = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        toolbarItems = [backItem, forwardItem, reload, space, grabItem]
        navigationController?.isToolbarHidden = false
        updateButtons()

        if auto { setUpOverlay() }

        let saved = UserDefaults.standard.string(forKey: Self.lastUrlKey).flatMap { URL(string: $0) }
        if let url = start ?? saved {
            webView.load(URLRequest(url: url))
            address.text = url.absoluteString
        } else {
            address.becomeFirstResponder()
        }
    }

    // MARK: automatic mode

    private func setUpOverlay() {
        overlay.backgroundColor = .systemBackground
        overlay.translatesAutoresizingMaskIntoConstraints = false
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.startAnimating()
        overlayLabel.text = label("loading", "Opening the chapter…")
        overlayLabel.textAlignment = .center
        overlayLabel.numberOfLines = 0
        overlayLabel.font = .preferredFont(forTextStyle: .headline)
        let show = UIButton(type: .system)
        show.setTitle(label("showPage", "Show the page"), for: .normal)
        show.addTarget(self, action: #selector(showPage), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [spinner, overlayLabel, show])
        stack.axis = .vertical
        stack.spacing = 18
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -32)
        ])
        // Regular checks: lazy pages and anti-bot redirects finish loading late.
        probeTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.probe() }
        // Still nothing: the website probably wants a tap (check box, consent…).
        giveUpTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            self?.stopAuto(message: self?.label("manual", "Finish opening the chapter, then tap “Get pages”."))
        }
    }

    @objc private func showPage() {
        stopAuto(message: label("manual", "Finish opening the chapter, then tap “Get pages”."))
    }

    private func stopAuto(message: String?) {
        guard auto else { return }
        auto = false
        probeTimer?.invalidate()
        giveUpTimer?.invalidate()
        UIView.animate(withDuration: 0.25, animations: { self.overlay.alpha = 0 }, completion: { _ in self.overlay.removeFromSuperview() })
        navigationItem.prompt = message
    }

    /// Looks for the chapter images; takes them once the page clearly holds a chapter.
    private func probe() {
        guard auto, !probing, !finished, !webView.isLoading else { return }
        probing = true
        collect { [weak self] found in
            guard let self = self else { return }
            self.probing = false
            guard self.auto, let found = found else { return }
            if found["blocked"] as? Bool == true {
                self.overlayLabel.text = self.label("checking", "The website is checking the browser…")
                return
            }
            if found["ready"] as? Bool == true { self.finish(found) }
        }
    }

    // MARK: actions

    @objc private func close() {
        finish(nil)
    }

    @objc private func goBack() {
        webView.goBack()
    }

    @objc private func goForward() {
        webView.goForward()
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    private func finish(_ result: [String: Any]?) {
        guard !finished else { return }
        finished = true
        probeTimer?.invalidate()
        giveUpTimer?.invalidate()
        webView.evaluateJavaScript("navigator.userAgent") { [weak self] value, _ in
            guard let self = self else { return }
            let agent = value as? String
            self.dismiss(animated: true) {
                self.completion(result, agent)
            }
        }
    }

    /// Scrolls through the page so lazy images get their address, then lists the images.
    private static let collector = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const startY = window.scrollY;
    for (let i = 0; i < 80; i++) {
      const before = window.scrollY;
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(120);
      if (window.scrollY === before) break;
    }
    await sleep(300);
    window.scrollTo(0, startY);
    const seen = new Set();
    const images = [];
    const last = (s) => (s ? s.split(',').pop().trim().split(/\\s+/)[0] : '');
    const add = (v) => {
      if (!v) return;
      v = v.trim();
      if (!v || v.startsWith('data:') || v.startsWith('blob:')) return;
      try { v = new URL(v, location.href).href; } catch (e) { return; }
      if (/^https?:/.test(v) && !seen.has(v)) { seen.add(v); images.push(v); }
    };
    for (const img of document.querySelectorAll('img')) {
      const d = img.dataset;
      const lazy = d.src || d.lazySrc || d.original || d.url || last(d.srcset);
      if (!lazy && img.complete && img.naturalWidth && (img.naturalWidth < 200 || img.naturalHeight < 200)) continue;
      add(lazy || img.currentSrc || last(img.getAttribute('srcset')) || img.src);
    }
    const nx = document.querySelector('link[rel~=next][href],a[rel~=next][href]') ||
      [...document.querySelectorAll('a[href]')].find((a) =>
        /(^|[\\s_-])next/i.test(a.className + ' ' + a.id) ||
        /^\\s*(next|suivant|chapitre suivant|next chapter|다음|次|下一)/i.test(a.textContent || ''));
    const next = nx && /^https?:/.test(nx.href) ? nx.href : '';
    // A chapter: at least 3 images in one folder (logos and ads live elsewhere).
    const folders = {};
    for (const u of images) { const f = u.slice(0, u.lastIndexOf('/') + 1); folders[f] = (folders[f] || 0) + 1; }
    const ready = Object.values(folders).some((n) => n >= 3);
    const blocked = /^(just a moment|attention required|access denied|checking your browser|ddos-guard)/i.test(document.title.trim());
    const cv = document.querySelector('meta[property="og:image"],meta[name="twitter:image"]');
    let cover = '';
    try { cover = cv && cv.content ? new URL(cv.content, location.href).href : ''; } catch (e) {}
    return JSON.stringify({ images, title: document.title, page: location.href, next, ready, blocked, cover });
    """

    /// Runs the collector in the page and returns what it found.
    private func collect(_ done: @escaping ([String: Any]?) -> Void) {
        webView.callAsyncJavaScript(Self.collector, arguments: [:], in: nil, in: .page) { result in
            var found: [String: Any]?
            if case .success(let value) = result, let json = value as? String, let data = json.data(using: .utf8) {
                found = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            done(found)
        }
    }

    @objc private func grab() {
        stopAuto(message: nil)
        grabItem.isEnabled = false
        grabItem.title = label("collecting", "Reading the page…")
        collect { [weak self] found in
            guard let self = self else { return }
            self.grabItem.isEnabled = true
            self.grabItem.title = self.label("grab", "Get pages")
            let images = found?["images"] as? [String] ?? []
            if images.isEmpty {
                let alert = UIAlertController(title: nil, message: self.label("noImages", "No image found on this page."), preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(alert, animated: true)
                return
            }
            self.finish(found)
        }
    }

    // MARK: address bar

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        let text = (textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return true }
        var url: URL?
        if text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://") {
            url = URL(string: text)
        } else if text.contains(".") && !text.contains(" ") {
            url = URL(string: "https://" + text)
        }
        if url == nil {
            var search = URLComponents(string: "https://duckduckgo.com/")!
            search.queryItems = [URLQueryItem(name: "q", value: text)]
            url = search.url
        }
        if let url = url { webView.load(URLRequest(url: url)) }
        return true
    }

    private func updateButtons() {
        backItem.isEnabled = webView.canGoBack
        forwardItem.isEnabled = webView.canGoForward
        if !address.isFirstResponder, let url = webView.url {
            address.text = url.absoluteString
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        updateButtons()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateButtons()
        if auto {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.probe() }
        }
        if let url = webView.url, url.scheme == "https" || url.scheme == "http" {
            UserDefaults.standard.set(url.absoluteString, forKey: Self.lastUrlKey)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        updateButtons()
    }

    /// Links that open a new window open in this one.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
