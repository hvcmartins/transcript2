"""
Speaker diarization via MFCC-based clustering.
No GPU needed — runs on CPU using librosa + scikit-learn.
Controlled by the ENABLE_DIARIZATION env var (default: true).
"""

import os
import subprocess
import tempfile

import numpy as np

DIARIZATION_ENABLED = os.getenv("ENABLE_DIARIZATION", "true").lower() in ("1", "true", "yes")


def _to_wav(audio_path: str) -> str:
    """Convert any audio/video file to 16 kHz mono WAV using ffmpeg."""
    tmp = tempfile.mktemp(suffix=".wav")
    result = subprocess.run(
        ["ffmpeg", "-i", audio_path, "-ar", "16000", "-ac", "1", "-y", tmp],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {result.stderr.decode()[:300]}")
    return tmp


def _mfcc_mean(audio: np.ndarray, sr: int, start: float, end: float, n_mfcc: int = 20):
    """Return mean MFCC vector for a time-slice, or None if the slice is too short."""
    import librosa

    s = int(start * sr)
    e = int(end * sr)
    seg = audio[s:e]
    if len(seg) < int(sr * 0.4):      # skip segments < 0.4 s
        return None
    mfccs = librosa.feature.mfcc(y=seg.astype(np.float32), sr=sr, n_mfcc=n_mfcc)
    return np.mean(mfccs, axis=1)


def diarize(audio_path: str, segments: list[dict]) -> list[dict]:
    """
    Add a 'speaker' key to each segment dict.
    Returns the original list unchanged if diarization is disabled or fails.
    """
    if not DIARIZATION_ENABLED or not segments:
        return segments

    if len(segments) == 1:
        return [{**segments[0], "speaker": "Speaker A"}]

    wav_path = None
    try:
        import librosa
        from sklearn.cluster import KMeans
        from sklearn.metrics import silhouette_score
        from sklearn.preprocessing import StandardScaler

        wav_path = _to_wav(audio_path)
        audio, sr = librosa.load(wav_path, sr=16000, mono=True)

        # ── Extract MFCC features per segment ────────────────────────────────
        features: list[np.ndarray] = []
        valid_idx: list[int] = []
        for i, seg in enumerate(segments):
            feat = _mfcc_mean(audio, sr, seg.get("start", 0), seg.get("end", 0))
            if feat is not None:
                features.append(feat)
                valid_idx.append(i)

        if len(features) < 2:
            return [{**s, "speaker": "Speaker A"} for s in segments]

        X = StandardScaler().fit_transform(np.array(features))

        # ── Pick number of speakers (2–4) via silhouette score ───────────────
        # Threshold of 0.30: single-speaker recordings routinely score 0.10–0.25
        # due to natural pitch/content variation; genuine multi-speaker audio
        # typically scores >= 0.30.
        MULTI_SPEAKER_THRESHOLD = 0.30
        best_n, best_score = 2, -1.0
        for n in range(2, min(5, len(features))):
            km = KMeans(n_clusters=n, n_init=10, random_state=42)
            labels = km.fit_predict(X)
            if len(set(labels)) < n:
                continue
            score = silhouette_score(X, labels)
            if score > best_score:
                best_score, best_n = score, n

        if best_score < MULTI_SPEAKER_THRESHOLD:
            return [{**s, "speaker": "Speaker A"} for s in segments]

        km = KMeans(n_clusters=best_n, n_init=10, random_state=42)
        cluster_labels = km.fit_predict(X)

        # ── Map cluster IDs to readable names in order of appearance ─────────
        seen: dict[int, str] = {}
        counter = 0
        speaker_for_valid: list[str] = []
        for lbl in cluster_labels:
            if lbl not in seen:
                seen[lbl] = chr(65 + counter)   # 'A', 'B', 'C', …
                counter += 1
            speaker_for_valid.append(f"Speaker {seen[lbl]}")

        # ── Rebuild segment list with speaker labels ──────────────────────────
        result: list[dict] = []
        valid_ptr = 0
        for i, seg in enumerate(segments):
            if i in valid_idx:
                spk = speaker_for_valid[valid_ptr]
                valid_ptr += 1
            else:
                spk = result[-1]["speaker"] if result else "Speaker A"
            result.append({**seg, "speaker": spk})

        return result

    except Exception as exc:
        print(f"[diarization] error — continuing without speakers: {exc}")
        return segments          # graceful fallback

    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)
