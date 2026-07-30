variable "project" {
  description = "Resource name prefix, e.g. `delivery`."
  type        = string
}

variable "environment" {
  description = "staging | production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = <<-EOT
    DigitalOcean region slug.

    `fra1` (Frankfurt) is the default for a Tunisian market: it is the closest
    DO region by latency and keeps data inside the EU, which matters for the
    GDPR posture in docs/07. Revisit if DB4 (in-country residency) resolves to
    "required".
  EOT
  type        = string
  default     = "fra1"
}

variable "vpc_cidr" {
  description = "Private network range. A /20 leaves room for the V2 cluster."
  type        = string
  default     = "10.20.0.0/20"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid CIDR block."
  }
}

variable "certificate_name" {
  description = "Name of the DigitalOcean-managed TLS certificate for the load balancer."
  type        = string
}

variable "app_droplet_tag" {
  description = "Tag identifying application droplets; the LB and firewall both target it."
  type        = string
}

variable "ssh_source_addresses" {
  description = <<-EOT
    CIDRs permitted to reach SSH.

    EMPTY IS THE CORRECT PRODUCTION VALUE once deploys run from CI — an empty
    list produces no SSH rule at all, which is stronger than a narrow one.
  EOT
  type        = list(string)
  default     = []
}
