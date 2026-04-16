import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, Camera, BookOpen, Users, Bell,
  Check, CheckCircle2, ChevronLeft, Trash2,
  Play, Pause, Zap, UserPlus, Image as ImageIcon,
  Edit3
} from "lucide-react";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

// Fallback reminders
const mockReminders = [
  { id: 1, text: "Doctor's appointment", detail: "Dr. Sharma", time: "Thursday, 11:00 AM", status: "pending" },
  { id: 2, text: "Take morning medication", detail: "Vitamin D", time: "8:00 AM", status: "pending" },
];

function Avatar({ letter, color = "var(--accent-purple)", size = 48, imageUrl = "" }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={letter || "face"}
        style={{ width: size, height: size, borderRadius: size / 3.5, objectFit: "cover", flexShrink: 0, border: '1px solid rgba(255,255,255,0.1)' }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: size / 3.5,
      background: `linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02))`,
      border: `1px solid rgba(255,255,255,0.1)`,
      display: "flex", alignItems: "center", justifyItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 700, color: "#fff", flexShrink: 0
    }}>
      {letter}
    </div>
  );
}

function Badge({ text, color = "var(--accent-blue)" }) {
  return (
    <span style={{
      background: `rgba(255,255,255,0.05)`, color,
      fontSize: 11, fontWeight: 600, padding: "5px 12px",
      borderRadius: 10, border: `1px solid rgba(255,255,255,0.1)`,
      letterSpacing: 0.5
    }}>
      {text}
    </span>
  );
}

// ─── Animations ───
const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -20, transition: { duration: 0.3 } }
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
};

// ─── CAPTURE SCREEN ───────────────────────────────────────────────────────────
function CaptureScreen({ onNewEntry, onReminderCreated, onFaceLibraryChanged }) {
  const [phase, setPhase] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [processingStep, setProcessingStep] = useState(0);
  const [capturedPhoto, setCapturedPhoto] = useState(false);
  const [identifiedPerson, setIdentifiedPerson] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [completedEntry, setCompletedEntry] = useState(null);
  const [suggestedReminders, setSuggestedReminders] = useState([]);
  const [addingReminder, setAddingReminder] = useState(false);

  const [savingFace, setSavingFace] = useState(false);
  const [showFaceNameModal, setShowFaceNameModal] = useState(false);
  const [pendingFaceName, setPendingFaceName] = useState("");
  const [tempFaceName, setTempFaceName] = useState("");

  const timerRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const steps = [
    { icon: <Camera size={18} />, text: "Detecting face…" },
    { icon: <Users size={18} />, text: "Recognising person…" },
    { icon: <Mic size={18} />, text: "Transcribing audio…" },
    { icon: <Zap size={18} />, text: "Generating summary…" },
    { icon: <Check size={18} />, text: "Saving to diary…" },
  ];

  useEffect(() => {
    if (phase === "recording") {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
      startAudioRecording();
    } else if (phase === "camera") {
      setTimeout(() => {
        if (videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current;
        }
      }, 50);
    } else {
      clearInterval(timerRef.current);
      if (phase !== "result" && phase !== "processing") setElapsed(0);
    }
    return () => clearInterval(timerRef.current);
  }, [phase]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setPhase("camera");
      setErrorMessage("");
    } catch (err) {
      console.error("Error accessing media devices.", err);
      setErrorMessage("Could not access camera/microphone.");
    }
  };

  const stopMediaTracks = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const capturePhoto = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      setCapturedPhoto(true);
      setIdentifiedPerson({ name: "Scanning...", relationship: "Matching library", avatar: "?" });

      const formData = new FormData();
      formData.append("file", blob, "capture.jpg");

      try {
        const response = await axios.post(`${API_BASE_URL}/identify-face`, formData);
        const person = (response.data.person || "").trim();
        if (response.data.verified && person) {
          setIdentifiedPerson({ name: person, relationship: "Recognized", avatar: person.charAt(0).toUpperCase() });
        } else {
          await autoSaveUnknownFace(blob);
        }
      } catch (e) {
        await autoSaveUnknownFace(blob);
      }
    }, "image/jpeg");
  };

  const autoSaveUnknownFace = async (blob) => {
    if (!blob) return;
    const autoName = `Person_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
    const formData = new FormData();
    formData.append("file", blob, "capture.jpg");

    try {
      setSavingFace(true);
      await axios.post(`${API_BASE_URL}/register-face/${encodeURIComponent(autoName)}`, formData);
      setIdentifiedPerson({ name: autoName, relationship: "Saved. Add a name", avatar: autoName.charAt(0).toUpperCase() });
      setTempFaceName(autoName);
      setShowFaceNameModal(true);
      onFaceLibraryChanged?.();
    } catch (err) {
      setIdentifiedPerson({ name: "Unknown", relationship: "No matching face found", avatar: "?" });
    } finally {
      setSavingFace(false);
    }
  };

  const saveFaceName = async () => {
    const finalName = (pendingFaceName || "").trim();
    if (!finalName || !tempFaceName) return setShowFaceNameModal(false);
    try {
      setSavingFace(true);
      await axios.patch(`${API_BASE_URL}/faces/${encodeURIComponent(tempFaceName)}`, { new_name: finalName });
      setIdentifiedPerson({ name: finalName, relationship: "Recognized", avatar: finalName.charAt(0).toUpperCase() });
      setShowFaceNameModal(false);
      setPendingFaceName("");
      setTempFaceName("");
      onFaceLibraryChanged?.();
    } catch (err) {
      setErrorMessage("Could not save face name.");
    } finally {
      setSavingFace(false);
    }
  };

  const startAudioRecording = () => {
    if (!streamRef.current) return;
    audioChunksRef.current = [];
    const mediaRecorder = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    mediaRecorder.start();
  };

  const stopRecordingAndProcess = () => {
    setPhase("processing");
    setProcessingStep(0);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setProcessingStep(1);
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.webm");
        formData.append("person_name", identifiedPerson?.name || "Unknown");

        try {
          setProcessingStep(2);
          const res = await axios.post(`${API_BASE_URL}/process-audio`, formData);
          setProcessingStep(3);
          setCompletedEntry(res.data.entry);
          setSuggestedReminders(res.data.suggested_reminders || []);
          setTimeout(() => {
            setProcessingStep(4);
            setTimeout(() => setPhase("result"), 500);
          }, 800);
        } catch (err) {
          setErrorMessage("Failed to process conversation.");
          setPhase("camera");
        }
      };
      mediaRecorderRef.current.stop();
      stopMediaTracks();
    }
  };

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <AnimatePresence mode="wait">
      {phase === "idle" && (
        <motion.div key="idle" variants={fadeUp} initial="hidden" animate="visible" exit="exit" className="scroll-content" style={{ padding: "30px 20px" }}>
          <h2 style={{ fontSize: 32, fontWeight: 700, margin: "0 0 8px", letterSpacing: -1 }}>Capture</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: 32 }}>Record a conversation to remember</p>

          <motion.div whileHover={{ scale: 1.02 }} className="bento-card" style={{ padding: "40px 24px", textAlign: "center", alignItems: "center" }}>
            <div style={{ width: 80, height: 80, borderRadius: 40, background: "rgba(129, 140, 248, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, border: "1px solid rgba(129, 140, 248, 0.3)" }}>
              <Mic size={36} color="var(--accent-purple)" />
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 12px" }}>Start a New Memory</h3>
            <p style={{ color: "var(--text-tertiary)", fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>Point your camera at the person and tap record. CareMate captures the face and conversation automatically.</p>
            <button onClick={startCamera} style={{ width: "100%", background: "var(--text-primary)", color: "#000", padding: "16px", borderRadius: 16, fontWeight: 600, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Camera size={20} /> Open Camera
            </button>
            {errorMessage && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 16 }}>{errorMessage}</div>}
          </motion.div>
        </motion.div>
      )}

      {phase === "camera" && (
        <motion.div key="camera" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ flex: 1, backgroundColor: "#000", position: "relative", overflow: "hidden" }}>
          <video 
            ref={(el) => { 
                videoRef.current = el; 
                if (el && streamRef.current) el.srcObject = streamRef.current; 
            }} 
            autoPlay playsInline muted 
            style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", opacity: 0.8 }} 
          />

          <div style={{ position: "absolute", top: 40, left: 20, right: 20, display: "flex", justifyContent: "space-between", zIndex: 10 }}>
            <button onClick={() => { setPhase("idle"); setCapturedPhoto(false); stopMediaTracks(); }} style={{ width: 44, height: 44, borderRadius: 22, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(10px)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,0.1)" }}>
              <ChevronLeft size={24} />
            </button>
            {capturedPhoto && identifiedPerson && (
              <div style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "8px 16px", color: "white", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <CheckCircle2 size={16} color="var(--accent-purple)" /> {identifiedPerson.name}
              </div>
            )}
          </div>

          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, paddingTop: "60px", paddingBottom: "120px", paddingLeft: "40px", paddingRight: "40px", background: "linear-gradient(to top, rgba(0,0,0,0.9) 20%, transparent)", display: "flex", justifyContent: "center", gap: 30, zIndex: 10 }}>
            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={capturePhoto} style={{ width: 72, height: 72, borderRadius: 36, border: `3px solid ${capturedPhoto ? 'var(--accent-purple)' : 'white'}`, background: capturedPhoto ? 'rgba(129,140,248,0.2)' : 'rgba(255,255,255,0.1)', display: "flex", alignItems: "center", justifyContent: "center", color: "white" }}>
              {capturedPhoto ? <Check size={30} /> : <Camera size={30} />}
            </motion.button>
            {capturedPhoto && (
              <motion.button initial={{ scale: 0 }} animate={{ scale: 1 }} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => setPhase("recording")} style={{ width: 72, height: 72, borderRadius: 36, background: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", boxShadow: "0 0 30px rgba(255,71,87,0.4)" }}>
                <Mic size={30} fill="currentColor" />
              </motion.button>
            )}
          </div>

          {showFaceNameModal && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, padding: 20 }}>
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bento-card" style={{ width: "100%", maxWidth: 360 }}>
                <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>New Face Detected</h3>
                <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>Enter person's name to remember them next time.</p>
                <input className="aurora-input" value={pendingFaceName} onChange={e => setPendingFaceName(e.target.value)} placeholder="Name" style={{ marginBottom: 16 }} />
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => setShowFaceNameModal(false)} style={{ flex: 1, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.05)", color: "white", fontWeight: 600 }}>Skip</button>
                  <button onClick={saveFaceName} style={{ flex: 1, padding: 12, borderRadius: 12, background: "var(--accent-blue)", color: "#000", fontWeight: 600 }}>Save</button>
                </div>
              </motion.div>
            </div>
          )}
        </motion.div>
      )}

      {phase === "recording" && (
        <motion.div key="recording" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div className="capture-orb-container">
            <div className="capture-orb-ring" style={{ width: 150, height: 150, animationDelay: "0s" }} />
            <div className="capture-orb-ring" style={{ width: 150, height: 150, animationDelay: "0.5s" }} />
            <motion.div animate={{ scale: [1, 1.1, 1] }} transition={{ repeat: Infinity, duration: 2 }} style={{ width: 120, height: 120, borderRadius: 60, background: "rgba(255, 71, 87, 0.2)", display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--danger)", boxShadow: "0 0 50px rgba(255,71,87,0.4)" }}>
              <Mic size={48} color="var(--danger)" />
            </motion.div>
          </div>
          <div style={{ fontSize: 64, fontWeight: 300, fontFamily: "monospace", letterSpacing: 4, margin: "20px 0 40px", color: "white" }}>{fmt(elapsed)}</div>
          <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={stopRecordingAndProcess} style={{ padding: "18px 40px", borderRadius: 30, background: "white", color: "black", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
            <Pause size={20} fill="currentColor" /> Stop Recording
          </motion.button>
        </motion.div>
      )}

      {phase === "processing" && (
        <motion.div key="processing" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 4, ease: "linear" }} style={{ width: 80, height: 80, borderRadius: 40, border: "4px solid rgba(255,255,255,0.1)", borderTopColor: "var(--accent-purple)", marginBottom: 40 }} />
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 30px" }}>Creating Memory...</h2>
          <div style={{ width: "100%", maxWidth: 300 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, opacity: i <= processingStep ? 1 : 0.2, transition: "opacity 0.4s" }}>
                <div style={{ width: 36, height: 36, borderRadius: 18, background: i < processingStep ? "var(--success)" : i === processingStep ? "var(--accent-purple)" : "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", color: i < processingStep || i === processingStep ? "#000" : "white" }}>
                  {i < processingStep ? <Check size={18} /> : s.icon}
                </div>
                <span style={{ fontSize: 16, fontWeight: 500 }}>{s.text}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {phase === "result" && (
        <motion.div key="result" variants={fadeUp} initial="hidden" animate="visible" className="scroll-content" style={{ padding: "30px 20px" }}>
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <CheckCircle2 size={64} color="var(--success)" style={{ margin: "0 auto 20px" }} />
            <h2 style={{ fontSize: 28, margin: "0 0 8px" }}>Memory Captured</h2>
          </div>

          <div className="bento-card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
              <Avatar letter={identifiedPerson?.avatar || "?"} color="var(--accent-pink)" size={60} />
              <div>
                <h3 style={{ margin: "0 0 4px", fontSize: 20 }}>{completedEntry?.person_name || "Unknown"}</h3>
                <Badge text={identifiedPerson?.relationship || "Unidentified"} color="var(--accent-pink)" />
              </div>
            </div>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 16, padding: 20, border: "1px solid rgba(255,255,255,0.05)" }}>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>{completedEntry?.summary}</p>
            </div>
          </div>

          {suggestedReminders.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="bento-card" style={{ marginBottom: 20, flexDirection: "row", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 22, background: "rgba(255, 165, 2, 0.2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--warning)" }}>
                <Bell size={20} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "var(--warning)", fontWeight: 600, marginBottom: 4 }}>Reminder Suggested</div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{suggestedReminders[0]?.title}</div>
              </div>
              <button disabled={addingReminder} onClick={async () => {
                const r = suggestedReminders[0];
                if (!r?.title || !completedEntry?.id) return;
                try {
                  setAddingReminder(true);
                  await axios.post(`${API_BASE_URL}/reminders`, { title: r.title, due_at: r.due_at ?? null, conversation_id: completedEntry.id });
                  setSuggestedReminders(p => p.slice(1));
                  onReminderCreated?.();
                } finally { setAddingReminder(false); }
              }} style={{ padding: "8px 16px", background: "white", color: "black", borderRadius: 12, fontWeight: 600, border: "none" }}>
                {addingReminder ? "..." : "Add"}
              </button>
            </motion.div>
          )}

          <button onClick={() => { onNewEntry(completedEntry); setPhase("idle"); }} style={{ width: "100%", padding: 16, borderRadius: 16, background: "var(--accent-purple)", color: "black", fontSize: 16, fontWeight: 600, marginBottom: 12, border: "none" }}>
            Go to Diary
          </button>
          <button onClick={() => setPhase("idle")} style={{ width: "100%", padding: 16, borderRadius: 16, background: "rgba(255,255,255,0.05)", color: "white", fontSize: 16, fontWeight: 500, border: "none" }}>
            Record Another
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── HOME ─────────────────────────────────────────────────────────────────────
function HomeScreen({ setScreen, diaryEntries, faces, reminders }) {
  const pendingCount = (reminders || []).filter(r => (r.status || "pending") === "pending").length;
  const latestEntry = diaryEntries?.[0];

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="scroll-content" style={{ padding: "30px 0" }}>
      <motion.div variants={fadeUp} style={{ padding: "0 20px 24px" }}>
        <p style={{ color: "var(--text-tertiary)", margin: "0 0 8px", fontSize: 14 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1 style={{ fontSize: 36, fontWeight: 700, margin: 0, letterSpacing: -1 }}>Hello</h1>
      </motion.div>

      <motion.div variants={fadeUp} className="bento-grid">
        <motion.div whileHover={{ scale: 1.02, y: -4 }} whileTap={{ scale: 0.98 }} onClick={() => setScreen("capture")} className="bento-card large" style={{ background: "linear-gradient(135deg, rgba(129, 140, 248, 0.2) 0%, rgba(56, 189, 248, 0.05) 100%)", cursor: "pointer", border: "1px solid rgba(129, 140, 248, 0.3)" }}>
          <div className="bento-icon-wrapper" style={{ background: "rgba(129, 140, 248, 0.2)" }}><Mic color="var(--accent-purple)" size={22} /></div>
          <h3 style={{ margin: "0 0 4px", fontSize: 20 }}>Capture Memory</h3>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>Record a conversation</p>
        </motion.div>

        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setScreen("diary")} className="bento-card" style={{ cursor: "pointer" }}>
          <div className="bento-icon-wrapper"><BookOpen color="var(--accent-blue)" size={20} /></div>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Diary</h3>
          <p style={{ margin: 0, color: "var(--text-tertiary)", fontSize: 12 }}>{diaryEntries.length} entries</p>
        </motion.div>

        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setScreen("contacts")} className="bento-card" style={{ cursor: "pointer" }}>
          <div className="bento-icon-wrapper"><Users color="var(--accent-pink)" size={20} /></div>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Faces</h3>
          <p style={{ margin: 0, color: "var(--text-tertiary)", fontSize: 12 }}>{faces.length} saved</p>
        </motion.div>

        <motion.div whileHover={{ scale: 1.02, y: -4 }} whileTap={{ scale: 0.98 }} onClick={() => setScreen("reminders")} className="bento-card large" style={{ flexDirection: "row", alignItems: "center", gap: 16, cursor: "pointer", padding: "16px 20px" }}>
          <div style={{ width: 44, height: 44, borderRadius: 16, background: "rgba(255,165,2,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}><Bell color="var(--warning)" size={20} /></div>
          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Reminders</h3>
            <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>{pendingCount} pending tasks</p>
          </div>
        </motion.div>
      </motion.div>

      {latestEntry && (
        <motion.div variants={fadeUp} style={{ padding: "30px 20px 0" }}>
          <h3 style={{ fontSize: 18, margin: "0 0 16px", color: "var(--text-secondary)" }}>Latest Memory</h3>
          <div className="bento-card">
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
              <Avatar letter={latestEntry.person_name?.charAt(0) || "?"} size={48} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{latestEntry.person_name}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{new Date(latestEntry.created_at).toLocaleString()}</div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{latestEntry.summary}</p>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── DIARY ────────────────────────────────────────────────────────────────────
function DiaryScreen({ entries, onDeleteEntry }) {
  const [selected, setSelected] = useState(null);

  return (
    <AnimatePresence mode="wait">
      {selected ? (
        <motion.div key="detail" variants={fadeUp} initial="hidden" animate="visible" exit="exit" className="scroll-content" style={{ padding: "20px" }}>
          <button onClick={() => setSelected(null)} style={{ color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8, marginBottom: 24, fontWeight: 600, border: "none" }}>
            <ChevronLeft size={20} /> Back
          </button>
          {(() => {
            const e = entries.find(x => x.id === selected);
            if (!e) return null;
            return (
              <div className="bento-card">
                <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
                  <Avatar letter={e.person_name?.charAt(0) || "?"} size={64} color="var(--accent-blue)" />
                  <div>
                    <h2 style={{ fontSize: 24, margin: "0 0 4px" }}>{e.person_name}</h2>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>{new Date(e.created_at).toLocaleString()}</div>
                  </div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", padding: 20, borderRadius: 16, marginBottom: 24, border: "1px solid rgba(255,255,255,0.05)" }}>
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: "var(--text-secondary)" }}>{e.summary}</p>
                </div>
                <button onClick={async () => {
                  if (window.confirm("Delete this?")) { await onDeleteEntry?.(e.id); setSelected(null); }
                }} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, background: "rgba(255,71,87,0.1)", color: "var(--danger)", borderRadius: 12, fontWeight: 600, border: "none" }}>
                  <Trash2 size={18} /> Delete Entry
                </button>
              </div>
            );
          })()}
        </motion.div>
      ) : (
        <motion.div key="list" variants={staggerContainer} initial="hidden" animate="visible" className="scroll-content" style={{ padding: "30px 20px" }}>
          <motion.h2 variants={fadeUp} style={{ fontSize: 32, fontWeight: 700, margin: "0 0 24px", letterSpacing: -1 }}>Diary</motion.h2>
          {entries.length === 0 && <p style={{ color: "var(--text-tertiary)" }}>Diary is empty.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {entries.map(e => (
              <motion.div variants={fadeUp} key={e.id} onClick={() => setSelected(e.id)} whileHover={{ scale: 1.02 }} className="bento-card" style={{ cursor: "pointer", padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
                  <Avatar letter={e.person_name?.charAt(0) || "?"} size={40} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{e.person_name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{new Date(e.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{e.summary}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
function ContactsScreen({ faces, refreshFaces }) {
  const [selected, setSelected] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [fileInput, setFileInput] = useState(null);

  const registerFace = async () => {
    if (!nameInput || !fileInput) return alert("Enter name and select image.");
    const fd = new FormData(); fd.append("file", fileInput);
    try {
      await axios.post(`${API_BASE_URL}/register-face/${encodeURIComponent(nameInput)}`, fd);
      setNameInput(""); setFileInput(null); await refreshFaces?.();
    } catch { alert("Failed."); }
  };

  if (selected) {
    const c = (faces || []).find(x => x.name === selected);
    if (!c) { setSelected(null); return null; }
    return (
      <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="scroll-content" style={{ padding: "20px" }}>
        <button onClick={() => setSelected(null)} style={{ color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8, marginBottom: 30, fontWeight: 600, border: "none" }}><ChevronLeft size={20} /> Back</button>
        <div className="bento-card" style={{ alignItems: "center", textAlign: "center", padding: "40px 20px" }}>
          <Avatar letter={c.name.charAt(0)} size={100} imageUrl={c.image_url ? `${API_BASE_URL}${c.image_url}` : ""} />
          <h2 style={{ fontSize: 26, margin: "20px 0 8px" }}>{c.name}</h2>
          <Badge text="Face Library" />
          <div style={{ display: "flex", gap: 12, width: "100%", marginTop: 32 }}>
            <button onClick={async () => {
              const ok = window.confirm("Delete face?");
              if (ok) { await axios.delete(`${API_BASE_URL}/faces/${encodeURIComponent(c.name)}`); await refreshFaces?.(); setSelected(null); }
            }} style={{ flex: 1, padding: 14, background: "rgba(255,71,87,0.1)", color: "var(--danger)", borderRadius: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: "none" }}>
              <Trash2 size={18} /> Delete
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="scroll-content" style={{ padding: "30px 20px" }}>
      <motion.h2 variants={fadeUp} style={{ fontSize: 32, fontWeight: 700, margin: "0 0 24px", letterSpacing: -1 }}>Faces</motion.h2>

      <motion.div variants={fadeUp} className="bento-card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 16px", display: "flex", alignItems: "center", gap: 8 }}><UserPlus size={18} color="var(--accent-pink)" /> Add New Face</h3>
        <input className="aurora-input" value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Person's Name" style={{ marginBottom: 12 }} />
        <input type="file" accept="image/*" onChange={e => setFileInput(e.target.files?.[0])} style={{ marginBottom: 16, color: "var(--text-secondary)", fontSize: 13 }} />
        <button onClick={registerFace} style={{ width: "100%", padding: 14, background: "white", color: "black", borderRadius: 12, fontWeight: 600, border: "none" }}>Register Face</button>
      </motion.div>

      <motion.div variants={staggerContainer} className="bento-grid" style={{ padding: 0 }}>
        {(faces || []).map(c => (
          <motion.div variants={fadeUp} key={c.name} whileHover={{ scale: 1.05 }} onClick={() => setSelected(c.name)} className="bento-card" style={{ padding: 20, cursor: "pointer", alignItems: "center", textAlign: "center" }}>
            <Avatar letter={c.name.charAt(0)} size={56} imageUrl={c.image_url ? `${API_BASE_URL}${c.image_url}` : ""} />
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>{c.name}</div>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}

// ─── REMINDERS ────────────────────────────────────────────────────────────────
function RemindersScreen({ reminders, refreshReminders }) {
  const toggle = async (r) => {
    try {
      const next = (r.status || "pending") === "done" ? "pending" : "done";
      await axios.patch(`${API_BASE_URL}/reminders/${r.id}`, { status: next });
      refreshReminders?.();
    } catch { }
  };
  const deleteReminder = async (r) => {
    try {
      if (!window.confirm("Delete this completed reminder?")) return;
      await axios.delete(`${API_BASE_URL}/reminders/${r.id}`);
      refreshReminders?.();
    } catch { }
  };
  const pending = (reminders || []).filter(r => (r.status || "pending") === "pending");
  const done = (reminders || []).filter(r => (r.status || "pending") === "done");

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="scroll-content" style={{ padding: "30px 20px" }}>
      <motion.h2 variants={fadeUp} style={{ fontSize: 32, fontWeight: 700, margin: "0 0 24px", letterSpacing: -1 }}>Reminders</motion.h2>

      {pending.length > 0 && (
        <motion.div variants={fadeUp} style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-tertiary)", margin: "0 0 16px" }}>Upcoming</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {pending.map(r => (
              <div key={r.id} className="bento-card" style={{ padding: "16px", flexDirection: "row", alignItems: "center", gap: 16 }}>
                <div style={{ width: 44, height: 44, borderRadius: 14, background: "rgba(255,165,2,0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--warning)" }}><Bell size={20} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "white" }}>{r.title || r.text}</div>
                  {r.due_at && <div style={{ fontSize: 13, color: "var(--warning)", marginTop: 4 }}>{new Date(r.due_at).toLocaleString()}</div>}
                </div>
                <button onClick={() => toggle(r)} style={{ width: 32, height: 32, borderRadius: 16, border: "2px solid var(--accent-purple)", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }} />
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {done.length > 0 && (
        <motion.div variants={fadeUp}>
          <h3 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-tertiary)", margin: "0 0 16px" }}>Completed</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {done.map(r => (
              <div key={r.id} className="bento-card" style={{ padding: "16px", flexDirection: "row", alignItems: "center", gap: 16, opacity: 0.5 }}>
                <div style={{ width: 44, height: 44, borderRadius: 14, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", color: "white" }}><Check size={20} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 500, color: "white", textDecoration: "line-through" }}>{r.title || r.text}</div>
                </div>
                <button
                  onClick={() => deleteReminder(r)}
                  title="Delete completed reminder"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    background: "rgba(255,71,87,0.15)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--danger)",
                    border: "1px solid rgba(255,71,87,0.35)",
                    marginRight: 8
                  }}
                >
                  <Trash2 size={16} />
                </button>
                <button onClick={() => toggle(r)} style={{ width: 32, height: 32, borderRadius: 16, background: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", color: "black", border: "none" }}><Check size={16} strokeWidth={3} /></button>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
function BottomNav({ screen, setScreen }) {
  const tabs = [
    { id: "home", icon: <Mic size={24} />, label: "Home" },
    { id: "capture", icon: <Camera size={24} />, label: "Capture" },
    { id: "diary", icon: <BookOpen size={24} />, label: "Diary" },
    { id: "contacts", icon: <Users size={24} />, label: "Faces" },
    { id: "reminders", icon: <Bell size={24} />, label: "Remind" },
  ];
  return (
    <div className="bottom-nav-glass">
      {tabs.map(tab => {
        const active = screen === tab.id;
        return (
          <button key={tab.id} onClick={() => setScreen(tab.id)} className={`nav-item ${active ? 'active' : ''}`} style={{ position: "relative" }}>
            {active && <motion.div layoutId="nav-bg" className="nav-indicator" transition={{ type: "spring", stiffness: 400, damping: 30 }} />}
            <motion.div whileTap={{ scale: 0.9 }} style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              {tab.icon}
            </motion.div>
          </button>
        );
      })}
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function CareMate() {
  const [screen, setScreen] = useState("home");
  const [diaryEntries, setDiaryEntries] = useState([]);
  const [faces, setFaces] = useState([]);
  const [reminders, setReminders] = useState([]);

  useEffect(() => {
    fetchDiaryEntries(); fetchFaces(); fetchReminders();
  }, []);

  const fetchDiaryEntries = async () => { try { const r = await axios.get(`${API_BASE_URL}/diary-entries`); setDiaryEntries(r.data.entries || []); } catch { } };
  const fetchFaces = async () => { try { const r = await axios.get(`${API_BASE_URL}/faces`); setFaces(r.data.faces || []); } catch { } };
  const fetchReminders = async () => { try { const r = await axios.get(`${API_BASE_URL}/reminders`); setReminders(r.data.reminders || []); } catch { setReminders(mockReminders); } };

  return (
    <div className="app-container">
      <div className="aurora-bg">
        <div className="aurora-blob purple" />
        <div className="aurora-blob pink" />
        <div className="aurora-blob blue" />
      </div>

      <AnimatePresence mode="wait">
        {screen === "home" && <HomeScreen key="home" setScreen={setScreen} diaryEntries={diaryEntries} faces={faces} reminders={reminders} />}
        {screen === "capture" && <CaptureScreen key="capture" onNewEntry={(e) => { fetchDiaryEntries(); setScreen("diary"); }} onReminderCreated={fetchReminders} onFaceLibraryChanged={fetchFaces} />}
        {screen === "diary" && <DiaryScreen key="diary" entries={diaryEntries} onDeleteEntry={async (id) => { await axios.delete(`${API_BASE_URL}/diary-entries/${id}`); setDiaryEntries(p => p.filter(x => x.id !== id)); }} />}
        {screen === "contacts" && <ContactsScreen key="contacts" faces={faces} refreshFaces={fetchFaces} />}
        {screen === "reminders" && <RemindersScreen key="reminders" reminders={reminders} refreshReminders={fetchReminders} />}
      </AnimatePresence>

      <BottomNav screen={screen} setScreen={setScreen} />
    </div>
  );
}
