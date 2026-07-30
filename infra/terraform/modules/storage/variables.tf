variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "spaces_region" {
  type        = string
  description = <<-EOT
    Spaces region slug.

    `fra1` keeps POD media in the EU alongside the database. Splitting them
    across jurisdictions would mean two answers to the same residency question.
  EOT
  default = "fra1"
}

variable "allowed_origins" {
  type        = list(string)
  description = <<-EOT
    Origins permitted to upload directly.

    Explicit, never `*` — a wildcard lets any page a driver happens to visit
    replay their pre-signed URL from the browser.
  EOT

  validation {
    condition     = !contains(var.allowed_origins, "*")
    error_message = "allowed_origins must not contain '*' — POD uploads are pre-signed and origin-bound."
  }
}
