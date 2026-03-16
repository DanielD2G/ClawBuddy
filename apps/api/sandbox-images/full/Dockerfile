FROM agentbuddy-sandbox-base

USER root

# Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI
RUN ARCH_SUFFIX=$([ "$(dpkg --print-architecture)" = "arm64" ] && echo "aarch64" || echo "x86_64") \
    && curl "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH_SUFFIX}.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip && ./aws/install \
    && rm -rf awscliv2.zip aws

# kubectl
RUN ARCH=$(dpkg --print-architecture) \
    && curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl

# Docker CLI (for managing host Docker via mounted socket)
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

USER sandbox
CMD ["sleep", "infinity"]
