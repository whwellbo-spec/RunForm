// In-app 120 fps recorder for RunForm.
//
// Records the back camera at 120 fps with AVAssetWriter, so the file carries
// real capture timestamps (no slow-mo retiming). While recording, Apple's
// Vision body-pose tracker runs on ~15 frames a second to check the whole body
// is in frame and to count steps; recording stops by itself once enough steps
// are captured for a reliable analysis.
import AudioToolbox
import AVFoundation
import Capacitor
import UIKit
import Vision

/// Bridge view controller that registers RunForm's own native plugin.
class RunFormBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(RunCameraPlugin())
    }
}

@objc(RunCameraPlugin)
public class RunCameraPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RunCameraPlugin"
    public let jsName = "RunCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "record", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteRecording", returnType: CAPPluginReturnPromise),
    ]

    @objc func record(_ call: CAPPluginCall) {
        let targetSteps = call.getInt("targetSteps") ?? 24
        let maxSeconds = call.getDouble("maxSeconds") ?? 45
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted else {
                    call.reject("Camera access is off. Turn it on in Settings › RunForm › Camera.", "DENIED")
                    return
                }
                let vc = RecorderViewController(targetSteps: targetSteps, maxSeconds: maxSeconds) { outcome in
                    switch outcome {
                    case .done(let data): call.resolve(data)
                    case .cancelled: call.reject("Recording cancelled", "CANCELLED")
                    case .failed(let msg): call.reject(msg, "FAILED")
                    }
                }
                vc.modalPresentationStyle = .fullScreen
                guard let host = self.bridge?.viewController else {
                    call.reject("Couldn't open the camera.", "FAILED")
                    return
                }
                host.present(vc, animated: true)
            }
        }
    }

    /// Delete a recording made by `record` (only files inside the recordings folder).
    @objc func deleteRecording(_ call: CAPPluginCall) {
        if let path = call.getString("path"), let url = URL(string: path),
           url.standardizedFileURL.path.hasPrefix(RecorderViewController.recordingsDir().standardizedFileURL.path) {
            try? FileManager.default.removeItem(at: url)
        }
        call.resolve()
    }
}

enum RecordOutcome {
    case done([String: Any])
    case cancelled
    case failed(String)
}

/// Device orientation at the start of a recording.
struct RecOrientation {
    let vision: CGImagePropertyOrientation
    let transform: CGAffineTransform

    static func current() -> RecOrientation {
        switch UIDevice.current.orientation {
        case .landscapeLeft: return RecOrientation(vision: .up, transform: .identity)
        case .landscapeRight: return RecOrientation(vision: .down, transform: CGAffineTransform(rotationAngle: .pi))
        case .portraitUpsideDown: return RecOrientation(vision: .left, transform: CGAffineTransform(rotationAngle: -.pi / 2))
        default: return RecOrientation(vision: .right, transform: CGAffineTransform(rotationAngle: .pi / 2))
        }
    }
}

/// Key joints from one Vision observation (normalized, origin bottom-left).
struct BodySample {
    var lAnkle: CGPoint?
    var rAnkle: CGPoint?
    var hip: CGPoint?
    var head: CGPoint?

    init(_ points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint]) {
        func p(_ n: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
            guard let q = points[n], q.confidence > 0.25 else { return nil }
            return q.location
        }
        lAnkle = p(.leftAnkle)
        rAnkle = p(.rightAnkle)
        let lh = p(.leftHip), rh = p(.rightHip)
        if let a = lh, let b = rh {
            let mx: CGFloat = (a.x + b.x) / 2
            let my: CGFloat = (a.y + b.y) / 2
            hip = CGPoint(x: mx, y: my)
        } else {
            hip = lh ?? rh ?? p(.root)
        }
        head = p(.nose) ?? p(.neck)
    }

    /// Head, hips and both ankles visible and not touching the frame edge.
    var wholeBody: Bool {
        guard let la = lAnkle, let ra = rAnkle, let h = head, hip != nil else { return false }
        return BodySample.inside(la) && BodySample.inside(ra) && BodySample.inside(h)
    }

    private static func inside(_ p: CGPoint) -> Bool {
        let okX: Bool = p.x > 0.01 && p.x < 0.99
        let okY: Bool = p.y > 0.02 && p.y < 0.98
        return okX && okY
    }

    /// Hip-to-ankle length, used to scale the step threshold.
    var legLength: CGFloat {
        guard let h = hip, let la = lAnkle, let ra = rAnkle else { return 0 }
        let ankleY: CGFloat = (la.y + ra.y) / 2
        return abs(h.y - ankleY)
    }
}

struct CounterUpdate {
    var detected: Bool
    var wholeBody: Bool
    var steps: Int
    var done: Bool
}

/// Counts steps from the left/right ankle difference. In side view the feet
/// pass each other (x); from the front or back the ankles alternate in height
/// (y). Each swing of the difference past a threshold is one step.
struct StepCounter {
    let target: Int
    private(set) var steps = 0
    /// Recording time (s) when running was first seen, and of the latest step.
    private(set) var runStartT = -1.0
    private(set) var lastStepT = -1.0
    private var state = 0
    private var axis = -1 // -1 undecided, 0 = x, 1 = y
    private var hist: [(t: Double, dx: CGFloat, dy: CGFloat, leg: CGFloat)] = []

    init(target: Int) { self.target = target }

    mutating func add(_ s: BodySample?, t: Double) -> CounterUpdate {
        let detected = s != nil
        guard let s = s, s.wholeBody, s.legLength > 0.05, let la = s.lAnkle, let ra = s.rAnkle else {
            return CounterUpdate(detected: detected, wholeBody: false, steps: steps, done: steps >= target)
        }
        guard t >= 0 else { return CounterUpdate(detected: true, wholeBody: true, steps: steps, done: false) }

        let dxNow: CGFloat = la.x - ra.x
        let dyNow: CGFloat = la.y - ra.y
        hist.append((t: t, dx: dxNow, dy: dyNow, leg: s.legLength))
        hist.removeAll { (h) -> Bool in t - h.t > 3 }
        let legs: [CGFloat] = hist.map { $0.leg }.sorted()
        let leg: CGFloat = legs[legs.count / 2]
        if axis < 0, let first = hist.first, t - first.t >= 1.0 {
            let xs: [CGFloat] = hist.map { $0.dx }
            let ys: [CGFloat] = hist.map { $0.dy }
            let rx: CGFloat = (xs.max() ?? 0) - (xs.min() ?? 0)
            let ry: CGFloat = (ys.max() ?? 0) - (ys.min() ?? 0)
            if max(rx, ry) > 0.3 * leg { axis = rx >= ry ? 0 : 1 }
        }
        if axis >= 0 {
            let raw: CGFloat = axis == 0 ? dxNow : dyNow
            let v: CGFloat = raw / leg
            // Remove a constant offset (e.g. feet apart from the front) with the recent median.
            let recent: [CGFloat] = (axis == 0 ? hist.map { $0.dx } : hist.map { $0.dy }).sorted()
            let centre: CGFloat = recent[recent.count / 2] / leg
            let d: CGFloat = v - centre
            let h: CGFloat = axis == 0 ? 0.15 : 0.06
            if state == 0 {
                if d > h { state = 1 } else if d < -h { state = -1 }
                if state != 0 && runStartT < 0 { runStartT = max(0, t - 0.5) }
            } else if (state == 1 && d < -h) || (state == -1 && d > h) {
                state = -state
                steps += 1
                lastStepT = t
            }
        }
        return CounterUpdate(detected: true, wholeBody: true, steps: steps, done: steps >= target)
    }
}

final class RecorderViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    static func recordingsDir() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = caches.appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let targetSteps: Int
    private let maxSeconds: Double
    private let onFinish: (RecordOutcome) -> Void

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let captureQueue = DispatchQueue(label: "runform.capture")
    private let visionQueue = DispatchQueue(label: "runform.vision")
    private var device: AVCaptureDevice?
    private var previewLayer: AVCaptureVideoPreviewLayer?

    // Capture-queue state.
    private var writer: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var fileURL: URL?
    private var recording = false
    private var startPTS = CMTime.invalid
    private var lastPTS = CMTime.invalid
    private var frameCount = 0
    private var droppedFrames = 0
    private var sampleIndex = 0
    private var visionBusy = false
    private var orientation = RecOrientation.current()

    // Vision-queue state.
    private var counter: StepCounter

    // Main-thread state.
    private var isRecordingUI = false
    private var stopping = false
    private var finished = false
    private var recordStart = Date()
    private var timer: Timer?

    private let topPanel = UIView()
    private let framingLabel = UILabel()
    private let stepsLabel = UILabel()
    private let hintLabel = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let recordButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    init(targetSteps: Int, maxSeconds: Double, onFinish: @escaping (RecordOutcome) -> Void) {
        self.targetSteps = max(6, targetSteps)
        self.maxSeconds = max(10, maxSeconds)
        self.onFinish = onFinish
        self.counter = StepCounter(target: max(6, targetSteps))
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self, selector: #selector(orientationChanged), name: UIDevice.orientationDidChangeNotification, object: nil)
        do {
            try configureSession()
        } catch {
            hintLabel.text = error.localizedDescription
            recordButton.isEnabled = false
            return
        }
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspect
        if let c = layer.connection, c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
        view.layer.insertSublayer(layer, at: 0)
        previewLayer = layer
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { s.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func orientationChanged() {
        guard !isRecordingUI else { return }
        let o = RecOrientation.current()
        captureQueue.async { self.orientation = o }
    }

    // MARK: - Session

    private struct RecError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private func configureSession() throws {
        guard let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw RecError(message: "No back camera found.")
        }
        device = dev
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .inputPriority
        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else { throw RecError(message: "Couldn't use the camera.") }
        session.addInput(input)

        // Pick a 120 fps format, preferring 1920×1080.
        var best: AVCaptureDevice.Format?
        var bestScore = -1
        for f in dev.formats {
            guard f.videoSupportedFrameRateRanges.contains(where: { $0.maxFrameRate >= 120 && $0.minFrameRate <= 120 }) else { continue }
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            var score = Int(d.width) <= 1920 ? Int(d.width) : 100
            if d.width == 1920 && d.height == 1080 { score = 5000 }
            if CMFormatDescriptionGetMediaSubType(f.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange { score += 1 }
            if score > bestScore { best = f; bestScore = score }
        }
        guard let fmt = best else { throw RecError(message: "This iPhone's camera can't record at 120 fps.") }
        try dev.lockForConfiguration()
        dev.activeFormat = fmt
        dev.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 120)
        dev.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 120)
        if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
        if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
        dev.unlockForConfiguration()

        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.alwaysDiscardsLateVideoFrames = false
        output.setSampleBufferDelegate(self, queue: captureQueue)
        guard session.canAddOutput(output) else { throw RecError(message: "Couldn't set up recording.") }
        session.addOutput(output)
    }

    // MARK: - Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if recording, let w = writer, let input = writerInput {
            if w.status == .unknown {
                if w.startWriting() {
                    w.startSession(atSourceTime: pts)
                    startPTS = pts
                }
            }
            if w.status == .writing {
                if input.isReadyForMoreMediaData, input.append(sampleBuffer) {
                    frameCount += 1
                    lastPTS = pts
                } else {
                    droppedFrames += 1
                }
            }
        }
        // Body tracking on every 8th frame (~15 Hz).
        sampleIndex += 1
        guard sampleIndex % 8 == 0, !visionBusy, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        visionBusy = true
        let t = recording && startPTS.isValid ? CMTimeGetSeconds(CMTimeSubtract(pts, startPTS)) : -1
        let vo = orientation.vision
        visionQueue.async { [weak self] in
            self?.track(pb, orientation: vo, t: t)
            self?.captureQueue.async { self?.visionBusy = false }
        }
    }

    private func track(_ pb: CVPixelBuffer, orientation: CGImagePropertyOrientation, t: Double) {
        let request = VNDetectHumanBodyPoseRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pb, orientation: orientation, options: [:])
        var sample: BodySample?
        if (try? handler.perform([request])) != nil, let obs = request.results?.first, let pts = try? obs.recognizedPoints(.all) {
            sample = BodySample(pts)
        }
        let update = counter.add(sample, t: t)
        DispatchQueue.main.async { [weak self] in self?.apply(update) }
    }

    // MARK: - UI

    private func buildUI() {
        topPanel.backgroundColor = UIColor(white: 0, alpha: 0.6)
        topPanel.layer.cornerRadius = 14
        for l in [framingLabel, stepsLabel, hintLabel] {
            l.textColor = .white
            l.numberOfLines = 0
            l.textAlignment = .center
        }
        framingLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        stepsLabel.font = .monospacedDigitSystemFont(ofSize: 34, weight: .bold)
        hintLabel.font = .systemFont(ofSize: 14)
        hintLabel.textColor = UIColor(white: 1, alpha: 0.85)
        framingLabel.text = "Looking for you…"
        stepsLabel.text = "120 fps"
        hintLabel.text = "Side view, phone at hip height, 3–5 m away. Tap record, then run. It stops by itself once it has \(targetSteps) steps."
        progress.progressTintColor = UIColor(red: 0.94, green: 0.41, blue: 0.30, alpha: 1)
        progress.trackTintColor = UIColor(white: 1, alpha: 0.25)
        progress.progress = 0

        let stack = UIStackView(arrangedSubviews: [framingLabel, stepsLabel, progress, hintLabel])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        topPanel.translatesAutoresizingMaskIntoConstraints = false
        topPanel.addSubview(stack)
        view.addSubview(topPanel)

        recordButton.translatesAutoresizingMaskIntoConstraints = false
        recordButton.backgroundColor = UIColor(red: 0.86, green: 0.2, blue: 0.16, alpha: 1)
        recordButton.layer.cornerRadius = 40
        recordButton.layer.borderWidth = 5
        recordButton.layer.borderColor = UIColor.white.cgColor
        recordButton.setTitle("", for: .normal)
        recordButton.accessibilityLabel = "Record"
        recordButton.addTarget(self, action: #selector(recordTapped), for: .touchUpInside)
        view.addSubview(recordButton)

        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancelButton)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topPanel.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            topPanel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            topPanel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: topPanel.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: topPanel.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: topPanel.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: topPanel.trailingAnchor, constant: -14),
            progress.heightAnchor.constraint(equalToConstant: 6),
            recordButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            recordButton.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            recordButton.widthAnchor.constraint(equalToConstant: 80),
            recordButton.heightAnchor.constraint(equalToConstant: 80),
            cancelButton.centerYAnchor.constraint(equalTo: recordButton.centerYAnchor),
            cancelButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
        ])
    }

    private func apply(_ u: CounterUpdate) {
        guard !finished else { return }
        if u.wholeBody {
            framingLabel.text = "✓ Whole body in frame"
            framingLabel.textColor = UIColor(red: 0.45, green: 0.85, blue: 0.6, alpha: 1)
        } else {
            framingLabel.text = u.detected ? "Get your whole body in frame, head to feet" : "Looking for you…"
            framingLabel.textColor = UIColor(red: 1, green: 0.75, blue: 0.3, alpha: 1)
        }
        guard isRecordingUI else { return }
        stepsLabel.text = "\(u.steps) / \(targetSteps) steps"
        progress.setProgress(min(1, Float(u.steps) / Float(targetSteps)), animated: true)
        if u.done { stop(auto: true) }
    }

    @objc private func recordTapped() {
        if isRecordingUI { stop(auto: false) } else { start() }
    }

    @objc private func cancelTapped() {
        captureQueue.async {
            let w = self.writer, url = self.fileURL
            self.recording = false
            self.writer = nil
            self.writerInput = nil
            if let w = w, w.status == .writing {
                w.cancelWriting()
            }
            if let url = url { try? FileManager.default.removeItem(at: url) }
            DispatchQueue.main.async { self.finish(.cancelled) }
        }
    }

    private func start() {
        guard let dev = device else { return }
        isRecordingUI = true
        recordStart = Date()
        recordButton.layer.cornerRadius = 12
        recordButton.accessibilityLabel = "Stop"
        stepsLabel.text = "0 / \(targetSteps) steps"
        hintLabel.text = "Recording at 120 fps. Start running — it stops by itself."
        let o = RecOrientation.current()
        let dims = CMVideoFormatDescriptionGetDimensions(dev.activeFormat.formatDescription)
        let target = targetSteps
        visionQueue.async { self.counter = StepCounter(target: target) }
        captureQueue.async {
            do {
                let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
                let url = Self.recordingsDir().appendingPathComponent("RunForm-\(stamp).mp4")
                try? FileManager.default.removeItem(at: url)
                let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
                let settings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: Int(dims.width),
                    AVVideoHeightKey: Int(dims.height),
                    AVVideoCompressionPropertiesKey: [
                        AVVideoAverageBitRateKey: 30_000_000,
                        AVVideoExpectedSourceFrameRateKey: 120,
                        AVVideoMaxKeyFrameIntervalKey: 60,
                        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                        AVVideoAllowFrameReorderingKey: false,
                    ] as [String: Any],
                ]
                let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
                input.expectsMediaDataInRealTime = true
                input.transform = o.transform
                guard w.canAdd(input) else { throw RecError(message: "Couldn't set up the recording.") }
                w.add(input)
                self.orientation = o
                self.writer = w
                self.writerInput = input
                self.fileURL = url
                self.startPTS = .invalid
                self.lastPTS = .invalid
                self.frameCount = 0
                self.droppedFrames = 0
                self.recording = true
            } catch {
                DispatchQueue.main.async { self.finish(.failed(error.localizedDescription)) }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self, self.isRecordingUI else { return }
            if Date().timeIntervalSince(self.recordStart) >= self.maxSeconds { self.stop(auto: true) }
        }
    }

    private func stop(auto: Bool) {
        guard isRecordingUI, !stopping else { return }
        stopping = true
        timer?.invalidate()
        if auto {
            AudioServicesPlaySystemSound(SystemSoundID(1114))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
        recordButton.isEnabled = false
        hintLabel.text = "Saving…"
        captureQueue.async {
            self.recording = false
            guard let w = self.writer, let input = self.writerInput, let url = self.fileURL, w.status == .writing else {
                DispatchQueue.main.async { self.finish(.failed("Nothing was recorded. Try again.")) }
                return
            }
            let frames = self.frameCount
            let dropped = self.droppedFrames
            let dur = self.startPTS.isValid && self.lastPTS.isValid ? CMTimeGetSeconds(CMTimeSubtract(self.lastPTS, self.startPTS)) : 0
            input.markAsFinished()
            w.finishWriting {
                let ok = w.status == .completed
                let err = w.error?.localizedDescription
                self.visionQueue.async {
                    let c = self.counter
                    DispatchQueue.main.async {
                        guard ok else {
                            try? FileManager.default.removeItem(at: url)
                            self.finish(.failed(err ?? "Couldn't save the recording."))
                            return
                        }
                        self.finish(.done([
                            "path": url.absoluteString,
                            "frames": frames,
                            "dropped": dropped,
                            "durationS": dur,
                            "steps": c.steps,
                            "runStartS": c.runStartT,
                            "runEndS": c.lastStepT,
                            "autoStopped": auto,
                        ]))
                    }
                }
            }
        }
    }

    private func finish(_ outcome: RecordOutcome) {
        guard !finished else { return }
        finished = true
        timer?.invalidate()
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
        dismiss(animated: true) { self.onFinish(outcome) }
    }
}
