FROM agentbuddy-sandbox-base

USER root
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && apt-get update && apt-get install -y --no-install-recommends unzip \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws /var/lib/apt/lists/*

USER sandbox
CMD ["sleep", "infinity"]
