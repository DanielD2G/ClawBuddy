---
name: docker
description: Execute Docker commands to manage containers and images.
compatibility: opencode
clawbuddy:
  displayName: Docker
  version: 1.0.0
  icon: Box
  category: devops
  type: bash
  networkAccess: true
  installation: apt-get update && apt-get install -y --no-install-recommends gpg
    && ARCH=$(dpkg --print-architecture) && curl -fsSL
    https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o
    /usr/share/keyrings/docker.gpg && echo "deb [arch=${ARCH}
    signed-by=/usr/share/keyrings/docker.gpg]
    https://download.docker.com/linux/ubuntu jammy stable" >
    /etc/apt/sources.list.d/docker.list && apt-get update && apt-get install -y
    --no-install-recommends docker-ce-cli && rm -rf /var/lib/apt/lists/*
  tools:
    - name: docker_command
      description: Execute a Docker command. The command should NOT include the
        "docker" prefix.
      prefix: docker
      parameters:
        type: object
        properties:
          command:
            type: string
            description: The Docker command (without the "docker" prefix), e.g. "ps" or
              "images"
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required:
          - command
  inputs:
    docker_host:
      type: var
      default: unix:///var/run/docker.sock
      description: Docker daemon socket or TCP address
---

You can execute Docker commands to manage containers and images in the sandbox environment.
