variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type        = string
  description = "Private range — the compute firewall's only permitted source."
}

variable "droplet_image" {
  type        = string
  description = "Base image slug. Pinned, never `latest`."
  default     = "docker-20-04"
}

variable "app_droplet_count" {
  type        = number
  default     = 2
  description = <<-EOT
    ⚠️ TWO is the floor in production.

    One instance means no rolling deploy, and it means the Valkey pub/sub path
    behind the realtime fan-out is never exercised — a dispatcher and a driver
    always land on the same process, so the cross-instance bug stays hidden
    until the day capacity forces a second box.
  EOT

  validation {
    condition     = var.app_droplet_count >= 1
    error_message = "app_droplet_count must be at least 1."
  }
}

variable "app_droplet_size" {
  type        = string
  default     = "s-4vcpu-8gb"
  description = "docs/09 §4.1: 4 vCPU / 8 GB per application VM at Tier 1."
}

variable "compute_droplet_count" {
  type        = number
  default     = 1
  description = "OSRM. Zero is valid before the Maghreb extract is loaded."
}

variable "compute_droplet_size" {
  type        = string
  default     = "s-8vcpu-16gb"
  description = "OSRM's graph is memory-hungry; docs/09 §4.1 sizes this at 8/16."
}

variable "app_droplet_tag" {
  type        = string
  description = "Targeted by the load balancer and both database firewalls."
}

variable "compute_droplet_tag" {
  type = string
}

variable "ssh_key_fingerprints" {
  type        = list(string)
  description = "Fingerprints of keys already uploaded to the account."
  default     = []
}

variable "cloud_init" {
  type        = string
  description = "cloud-config run at first boot. Never contains a secret — those arrive at runtime."
  default     = ""
}
