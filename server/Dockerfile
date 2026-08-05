# Builds the Kokoro Reader companion server. CPU by default (works
# anywhere); pass --build-arg TORCH_INDEX_URL=... for GPU builds. See
# README.md ("Docker") for build/run examples for CPU, NVIDIA, and AMD.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installed separately from requirements.txt so the index URL (and
# therefore which hardware backend you get) is a build-time choice.
# Defaults to CPU -- the one build guaranteed to work on any machine
# regardless of GPU vendor or whether one is even present.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch --index-url "${TORCH_INDEX_URL}"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# misaki (kokoro's English text-processing dependency) auto-downloads
# this spaCy model the first time it's actually used if it's missing.
# That auto-download happens at *runtime*, as the non-root user below,
# which can't write to this directory -- pip silently falls back to a
# --user install the already-running server process can't see, so
# synthesis fails with "[E050] Can't find model 'en_core_web_sm'"
# despite the install itself reporting success. Installing it here
# instead, as root, at build time, avoids that entirely.
RUN python -m spacy download en_core_web_sm

COPY app/ app/

RUN useradd --create-home --uid 1000 kokoro
ENV XDG_CONFIG_HOME=/home/kokoro/.config
ENV HF_HOME=/home/kokoro/.cache/huggingface
RUN mkdir -p "$XDG_CONFIG_HOME" "$HF_HOME" && chown -R kokoro:kokoro /home/kokoro /app
USER kokoro

# Must bind all interfaces inside the container -- Docker's port
# mapping forwards to this address, not the container's loopback.
# The *host* side of that mapping is what should stay loopback-only
# (see README: use `-p 127.0.0.1:8787:8787`, not `-p 8787:8787`,
# unless you deliberately want it LAN-reachable).
ENV KOKORO_HOST=0.0.0.0
ENV KOKORO_PORT=8787
EXPOSE 8787

CMD ["python", "-m", "app.main"]
