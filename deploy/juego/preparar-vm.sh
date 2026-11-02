#!/usr/bin/env bash
# Run ONCE on the new VM (Debian 12), from its SSH window in the Google Cloud console:
#   curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/master/deploy/juego/preparar-vm.sh | bash -s -- <region>
# or copy the file and run:  bash preparar-vm.sh northamerica-south1
#
# Installs Docker with its compose plugin, and lets Docker pull images from Artifact Registry
# with the VM's own service account (no keys on the machine).
set -euo pipefail

REGION="${1:-northamerica-south1}"

# Docker from its official repository
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

sudo systemctl enable --now docker

# Pulling from Artifact Registry with the VM's identity (Debian images on GCE come with gcloud).
# It's root's Docker config: the workflow runs `sudo docker compose`
sudo gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

sudo mkdir -p /opt/juego
echo "Listo: Docker instalado y con acceso a ${REGION}-docker.pkg.dev"
