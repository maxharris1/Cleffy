# Cursor Cloud Agent image for Cleffy.
# Goal: Node toolchain + Deno + Docker-in-Docker so the agent can run
# `supabase start` and serve the Vite app + edge functions against a local stack.
#
# Referenced from .cursor/environment.json via build.dockerfile (relative to .cursor)
# and build.context ".." (repo root). Do NOT COPY the project — Cursor manages the
# workspace checkout itself.
#
# Validate after edits: docker build -f .cursor/Dockerfile .

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

########################################################
# BASE TOOLCHAIN
########################################################

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    git \
    sudo \
    unzip \
    jq \
    build-essential \
    python3 \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (matches package.json engines / Vite 8 / React 19)
RUN curl --retry 3 --retry-delay 5 -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Deno (Supabase Edge Functions runtime for `npm run functions:serve`)
RUN curl --retry 3 --retry-delay 5 -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    deno --version

########################################################
# DOCKER INSTALLATION (Docker-in-Docker for local Supabase)
########################################################

RUN install -m 0755 -d /etc/apt/keyrings && \
    curl --retry 3 --retry-delay 5 -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# fuse-overlayfs storage driver — required for reliable Docker-in-Docker on cloud agents.
RUN apt-get update && apt-get install -y fuse-overlayfs && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/docker && \
    printf '%s\n' '{' \
    '  "storage-driver": "fuse-overlayfs"' \
    '}' > /etc/docker/daemon.json

# iptables-legacy — Docker networking inside the nested container needs legacy iptables.
RUN apt-get update && apt-get install -y iptables && rm -rf /var/lib/apt/lists/*
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

########################################################
# NON-ROOT USER (Cursor Cloud Agent runs as ubuntu in the docker group)
########################################################

RUN id -u ubuntu &>/dev/null || useradd -m -s /bin/bash ubuntu
RUN groupadd -f docker && usermod -aG docker ubuntu
RUN usermod -aG sudo ubuntu
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu
RUN echo "ubuntu:ubuntu" | chpasswd

USER ubuntu
