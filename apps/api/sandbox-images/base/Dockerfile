FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    jq \
    git \
    ca-certificates \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox
WORKDIR /workspace
RUN chown sandbox:sandbox /workspace

USER sandbox
CMD ["sleep", "infinity"]
