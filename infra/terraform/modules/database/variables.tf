variable "project" {
  type        = string
  description = "Resource name prefix."
}

variable "environment" {
  type        = string
  description = "staging | production."
}

variable "region" {
  type        = string
  description = "Must match the VPC's region — a managed database cannot join a VPC elsewhere."
}

variable "vpc_id" {
  type        = string
  description = "VPC to attach both clusters to. Without it they get a public endpoint."
}

variable "database_name" {
  type        = string
  description = "Logical database name."
  default     = "delivery"
}

variable "postgres_size" {
  type        = string
  description = <<-EOT
    Cluster size slug.

    Sized from docs/06 §11: Tier 1 is ~20 GB and 20 business writes/sec, which
    the smallest production size covers with room. Telemetry is the growth
    driver, and its 90-day retention bounds it.
  EOT
  default     = "db-s-2vcpu-4gb"
}

variable "postgres_node_count" {
  type        = number
  description = <<-EOT
    2 gives a standby with automatic failover.

    ⚠️ Not a read replica. Analytics and exports move to genuine replicas at
    Tier 2 (docs/06 §7); this is availability, not throughput.
  EOT
  default     = 2

  validation {
    condition     = var.postgres_node_count >= 1 && var.postgres_node_count <= 3
    error_message = "postgres_node_count must be between 1 and 3."
  }
}

variable "valkey_size" {
  type        = string
  description = "Valkey holds presence, streams and consumer-group state — not just a cache."
  default     = "db-s-1vcpu-2gb"
}

variable "valkey_node_count" {
  type    = number
  default = 2
}

variable "allowed_droplet_tags" {
  type        = list(string)
  description = "Droplet tags permitted to connect. Anything untagged is refused."
}
