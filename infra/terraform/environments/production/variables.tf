variable "do_token" {
  type        = string
  sensitive   = true
  description = "DigitalOcean API token. From the CI secret store as TF_VAR_do_token — never a file."
}

variable "spaces_access_id" {
  type        = string
  sensitive   = true
  description = "Spaces access key. Separate from the API token."
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}

variable "region" {
  type        = string
  default     = "fra1"
  description = "Frankfurt — closest DO region to Tunisia, and keeps data in the EU."
}

variable "certificate_name" {
  type        = string
  description = "Name of the DigitalOcean-managed TLS certificate."
}

variable "ssh_key_fingerprints" {
  type        = list(string)
  default     = []
  description = "Keys already uploaded to the account. Empty is valid — production has no SSH rule."
}

variable "allowed_origins" {
  type        = list(string)
  description = "Origins permitted to upload POD media directly. Never '*'."
}
