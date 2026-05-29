"""
Intel GPU transcription via optimum-intel + OpenVINO.

Uses model.generate() directly as recommended by transformers for Whisper —
the pipeline abstraction doesn't handle seq2seq chunking correctly.

Requirements: pip install optimum[openvino] transformers
Build with Dockerfile.openvino (Ubuntu 24.04 + Intel GPU drivers).

Environment variables:
  MODELS_DIR      — HuggingFace cache root  (default: models)
  OPENVINO_DEVICE — "GPU" | "CPU" | "AUTO"  (default: AUTO)
"""

import os
import re
from pathlib import Path

MODELS_DIR      = Path(os.getenv("MODELS_DIR", "models"))
OPENVINO_DEVICE = os.getenv("OPENVINO_DEVICE", "AUTO")

_HF_CACHE = MODELS_DIR / "openvino_hf"

SUPPORTED_OV_MODELS = [
    {"id": "tiny",           "hf_id": "OpenVINO/whisper-tiny-int8-ov",            "label": "Tiny — ~40 MB · fastest"},
    {"id": "base",           "hf_id": "OpenVINO/whisper-base-int8-ov",            "label": "Base — ~80 MB · fast"},
    {"id": "small",          "hf_id": "OpenVINO/whisper-small-int8-ov",           "label": "Small — ~240 MB · balanced ✓"},
    {"id": "medium",         "hf_id": "OpenVINO/whisper-medium-int8-ov",          "label": "Medium — ~780 MB · accurate"},
    {"id": "large-v3-turbo", "hf_id": "OpenVINO/whisper-large-v3-turbo-int8-ov", "label": "Large v3 Turbo — ~900 MB · fast+accurate"},
    {"id": "large-v3",       "hf_id": "OpenVINO/whisper-large-v3-int8-ov",       "label": "Large v3 — ~1.6 GB · best"},
]

_model_cache: dict = {}


def _hf_id(model_id: str) -> str:
    for m in SUPPORTED_OV_MODELS:
        if m["id"] == model_id:
            return m["hf_id"]
    return f"OpenVINO/whisper-{model_id}-int8-ov"


def _is_available() -> bool:
    try:
        from optimum.intel import OVModelForSpeechSeq2Seq  # noqa: F401
        return True
    except ImportError:
        return False


OPENVINO_AVAILABLE = _is_available()


def is_ov_model_cached(model_id: str) -> bool:
    cache_name = "models--" + _hf_id(model_id).replace("/", "--")
    model_dir = _HF_CACHE / cache_name
    return model_dir.exists() and any(model_dir.iterdir())


def _load(model_id: str):
    """Load and cache (model, processor) pair."""
    global _model_cache
    if model_id not in _model_cache:
        from optimum.intel import OVModelForSpeechSeq2Seq
        from transformers import AutoProcessor

        hf_id = _hf_id(model_id)
        _HF_CACHE.mkdir(parents=True, exist_ok=True)

        model = OVModelForSpeechSeq2Seq.from_pretrained(
            hf_id,
            device=OPENVINO_DEVICE,
            cache_dir=str(_HF_CACHE),
        )
        processor = AutoProcessor.from_pretrained(
            hf_id,
            cache_dir=str(_HF_CACHE),
        )
        _model_cache[model_id] = (model, processor)
    return _model_cache[model_id]


_TS_RE = re.compile(r"<\|[\d.]+\|>")

_CHUNK = 30 * 16000   # 30 s at 16 kHz


class _LogitCapture:
    """
    A transformers LogitsProcessor that saves raw logits at each non-forced
    generation step.  Passed via logits_processor= — no need for
    return_dict_in_generate, so it works with OVModelForSpeechSeq2Seq.
    """
    def __init__(self):
        self.captured: list = []

    def __call__(self, input_ids, scores):
        import numpy as np
        s = scores[0]  # batch 0
        if hasattr(s, "numpy"):
            arr = s.numpy()
        elif hasattr(s, "detach"):
            arr = s.detach().numpy()
        else:
            arr = np.asarray(s)
        self.captured.append(arr.astype(np.float32))
        return scores


def _extract_seg_logprobs(captured_logits: list, token_ids: list, tokenizer) -> list:
    """
    Given per-step raw logits and the full token sequence (including forced prefix),
    return one avg_logprob per timestamp-delimited segment.

    Whisper layout after the forced prefix:
      <|t_start|> text_tok... <|t_end|> <|t_start|> text_tok... <|t_end|> ...

    We average log-P(text tokens) within each pair and skip timestamp tokens.
    Returns [] on any error so callers can fall back to avg_logprob=None.
    """
    import numpy as np

    if not captured_logits:
        return []

    # WhisperTokenizerFast doesn't expose .timestamp_begin; fall back to vocab lookup
    ts_begin: int | None = getattr(tokenizer, "timestamp_begin", None)
    if ts_begin is None:
        tok = tokenizer.convert_tokens_to_ids("<|0.00|>")
        if isinstance(tok, int) and tok not in (None, getattr(tokenizer, "unk_token_id", -1)):
            ts_begin = tok
    if ts_begin is None:
        return []

    # The OV model may call the LogitsProcessor for EOS/pad steps that don't produce
    # a token in ids[0], so captured can be >= len(token_ids).  Clamp to be safe.
    num_forced = max(0, len(token_ids) - len(captured_logits))
    gen_token_ids = token_ids[num_forced:]
    n_match = min(len(gen_token_ids), len(captured_logits))



    # Compute log-prob of the chosen token at each generation step
    token_logprobs: list[tuple[int, float]] = []
    for logits, tok_id in zip(captured_logits[:n_match], gen_token_ids[:n_match]):
        logits = logits.astype(np.float64)
        shifted = logits - logits.max()
        # Clamp to [-10, 0]: suppressed tokens have logit=-inf so shifted[tok_id]
        # can be -inf; clamp prevents -inf propagating into avg_logprob.
        lp = float(np.clip(shifted[tok_id] - np.log(np.sum(np.exp(shifted))), -10.0, 0.0))
        token_logprobs.append((tok_id, lp))

    # Walk pairs of timestamp tokens, average text-token log-probs per segment
    seg_logprobs: list = []
    i, n = 0, len(token_logprobs)
    while i < n:
        tok_id, _ = token_logprobs[i]
        if tok_id >= ts_begin:
            i += 1  # consume start-timestamp
            text_lps: list[float] = []
            while i < n:
                tok_id2, lp2 = token_logprobs[i]
                if tok_id2 >= ts_begin:
                    i += 1  # consume end-timestamp
                    break
                if np.isfinite(lp2):
                    text_lps.append(lp2)
                i += 1
            if text_lps:
                seg_logprobs.append(float(np.mean(text_lps)))
        else:
            i += 1

    return seg_logprobs


def _parse_tokens_to_segments(
    token_ids: list,
    processor,
    offset_s: float,
    seg_logprobs: list,
) -> tuple[list[dict], str]:
    """
    Walk the raw Whisper token sequence and return (segments, full_text).

    This replaces batch_decode(output_offsets=True) which only returns one
    offset entry per timestamp pair and can miss intermediate pairs when the
    model generates multiple sentence-level boundaries inside one 30-second chunk.

    Whisper timestamp token layout:
      <|t_start|>  text tokens...  <|t_end|>   (repeat)   <|endoftext|>
    """
    ts_begin  = processor.tokenizer.convert_tokens_to_ids("<|0.00|>")
    eos_id    = processor.tokenizer.eos_token_id
    time_prec = 0.02  # seconds per timestamp token step

    if ts_begin is None or ts_begin < 0:
        return [], ""

    segments: list[dict] = []
    lp_idx = 0
    i, n = 0, len(token_ids)

    while i < n:
        tok = token_ids[i]
        if tok == eos_id:
            break
        if tok >= ts_begin:
            start_time = (tok - ts_begin) * time_prec
            i += 1
            text_toks: list[int] = []
            end_time = start_time + 30.0  # fallback
            while i < n:
                tok2 = token_ids[i]
                if tok2 == eos_id:
                    break
                if tok2 >= ts_begin:
                    end_time = (tok2 - ts_begin) * time_prec
                    i += 1
                    break
                text_toks.append(tok2)
                i += 1
            if text_toks:
                text = processor.tokenizer.decode(
                    text_toks, skip_special_tokens=True
                ).strip()
                if text:
                    avg_lp = seg_logprobs[lp_idx] if lp_idx < len(seg_logprobs) else None
                    lp_idx += 1
                    import math
                    if avg_lp is not None and not math.isfinite(avg_lp):
                        avg_lp = None
                    segments.append({
                        "start":       round(start_time + offset_s, 3),
                        "end":         round(end_time   + offset_s, 3),
                        "text":        text,
                        "avg_logprob": avg_lp,
                    })
        else:
            i += 1

    full_text = " ".join(s["text"] for s in segments)
    return segments, full_text


def transcribe_openvino(
    file_path: str,
    language: str = "auto",
    model_id: str = "small",
    progress_cb=None,
) -> dict:
    """
    Blocking — run via asyncio.to_thread() from an async context.
    Returns the same dict shape as groq_service.transcribe_file().
    """
    if not OPENVINO_AVAILABLE:
        raise RuntimeError(
            "optimum-intel is not installed. Build the image with Dockerfile.openvino."
        )

    import librosa
    import numpy as np

    if progress_cb:
        progress_cb(32)

    model, processor = _load(model_id)

    audio, _ = librosa.load(file_path, sr=16000, mono=True)
    duration  = float(len(audio)) / 16000.0

    if progress_cb:
        progress_cb(38)

    # Generation kwargs
    gen_kwargs: dict = {"return_timestamps": True, "task": "transcribe"}
    if language and language != "auto":
        gen_kwargs["language"] = language

    # Split into 30-second chunks (Whisper's native input window)
    positions = list(range(0, max(1, len(audio)), _CHUNK))
    segments:    list[dict] = []
    text_parts:  list[str]  = []

    for i, pos in enumerate(positions):
        chunk = audio[pos : pos + _CHUNK].astype(np.float32)
        # Pad final chunk to exactly 30 s
        if len(chunk) < _CHUNK:
            chunk = np.pad(chunk, (0, _CHUNK - len(chunk)))

        offset_s = pos / 16000.0

        input_features = processor.feature_extractor(
            chunk, sampling_rate=16000, return_tensors="pt"
        ).input_features

        # Capture per-token logits for confidence extraction via a LogitsProcessor
        # hook — more compatible with OVModelForSpeechSeq2Seq than return_dict_in_generate.
        from transformers import LogitsProcessorList
        capture = _LogitCapture()
        try:
            ids = model.generate(
                input_features,
                **gen_kwargs,
                logits_processor=LogitsProcessorList([capture]),
            )
            token_ids = ids[0].tolist() if hasattr(ids[0], "tolist") else list(ids[0])
            seg_logprobs = _extract_seg_logprobs(capture.captured, token_ids, processor.tokenizer)
        except Exception as exc:
            print(f"[openvino] logit capture failed ({type(exc).__name__}: {exc}), retrying plain", flush=True)
            ids = model.generate(input_features, **gen_kwargs)
            seg_logprobs = []

        # Walk tokens directly — batch_decode(output_offsets=True) collapses all
        # timestamp pairs in a chunk into a single offset entry, so we get one
        # 30-second segment per chunk instead of sentence-level breaks.
        token_ids_for_parse = ids[0].tolist() if hasattr(ids[0], "tolist") else list(ids[0])
        chunk_segs, chunk_text = _parse_tokens_to_segments(
            token_ids_for_parse, processor, offset_s, seg_logprobs
        )
        segments.extend(chunk_segs)
        if chunk_text:
            text_parts.append(chunk_text)
        print(
            f"[openvino] chunk {i}: {len(chunk_segs)} segs from {len(token_ids_for_parse)} tokens",
            flush=True,
        )

        if progress_cb:
            pct = 38 + int((i + 1) / len(positions) * 45)
            progress_cb(min(83, pct))

    full_text = " ".join(text_parts).strip()

    if not segments:
        segments = [{"start": 0.0, "end": duration, "text": full_text, "avg_logprob": None}]

    lp_vals = [s["avg_logprob"] for s in segments if s.get("avg_logprob") is not None]
    print(
        f"[openvino] segments={len(segments)}  avg_logprob present={len(lp_vals)}"
        f"  sample={[round(v,3) for v in lp_vals[:3]] if lp_vals else 'none'}",
        flush=True,
    )

    return {
        "text":     full_text,
        "segments": segments,
        "words":    [],
        "duration": duration,
        "language": language,
    }
