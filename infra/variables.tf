/**
 * infra/variables.tf [EXT]
 * Inputs shared across this stack. Values differ only via envs/<env>/terraform.tfvars —
 * the .tf files themselves are identical across dev, staging and prod.
 */

variable "environment" {
  description = "dev | staging | prod — drives naming, sizing and NAT topology"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "Primary region for VPC, ECS, RDS, Redis, OpenSearch."
  type        = string
  default     = "eu-central-1"
}

variable "domain_name" {
  description = "Root domain for this environment, e.g. dev.classroom.app or classroom.app for prod."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the environment's VPC. Kept non-overlapping across envs for future peering."
  type        = string
}

variable "az_count" {
  description = "Number of Availability Zones to spread subnets across."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "true = one shared NAT Gateway (cheaper, used in dev/staging). false = one NAT per AZ (prod HA)."
  type        = bool
  default     = true
}

# ---- Container images (owned by ecr.tf, not yet built — placeholders until then) ----
variable "api_image" {
  description = "ECR image URI:tag for the api/realtime service (server/Dockerfile.api)."
  type        = string
  default     = null
}

variable "worker_image" {
  description = "ECR image URI:tag for the worker service (server/Dockerfile.worker)."
  type        = string
  default     = null
}

variable "sfu_image" {
  description = "ECR image URI:tag for the mediasoup SFU (server/Dockerfile.sfu)."
  type        = string
  default     = null
}

# ---- ECS sizing ----
variable "container_port" {
  description = "Port the api/realtime container listens on."
  type        = number
  default     = 4000
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_task_cpu" {
  type    = number
  default = 512
}

variable "api_task_memory" {
  type    = number
  default = 1024
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "worker_task_cpu" {
  type    = number
  default = 1024
}

variable "worker_task_memory" {
  type    = number
  default = 2048
}

# ---- SFU (ECS on EC2, host networking) ----
variable "sfu_instance_type" {
  type    = string
  default = "c6i.xlarge"
}

variable "sfu_min_size" {
  type    = number
  default = 1
}

variable "sfu_max_size" {
  type    = number
  default = 6
}

variable "sfu_desired_capacity" {
  type    = number
  default = 1
}

# ---- Data layer ----
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_engine_version" {
  type    = string
  default = "16.4"
}

variable "db_name" {
  type    = string
  default = "classroom"
}

variable "db_username" {
  type    = string
  default = "classroom_app"
}

variable "create_read_replica" {
  description = "Read replica for feed/search-fallback/reporting queries — usually off in dev."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "opensearch_instance_type" {
  type    = string
  default = "t3.small.search"
}

variable "opensearch_volume_size_gb" {
  type    = number
  default = 20
}

# ---- Backup / DR ----
variable "backup_region" {
  description = "Secondary region PITR snapshots are copied into."
  type        = string
  default     = "eu-west-1"
}

# ---- KMS ----
variable "kms_deletion_window" {
  type    = number
  default = 30
}

# ---- TURN ----
variable "turn_instance_type" {
  type    = string
  default = "t3.small"
}

variable "turn_shared_secret" {
  description = "Shared secret for coturn's use-auth-secret mechanism (TURN_SECRET)."
  type        = string
  sensitive   = true
  default     = null
}

# ---- Push (SNS platform applications) ----
variable "apns_certificate_pem" {
  type      = string
  sensitive = true
  default   = null
}

variable "apns_private_key_pem" {
  type      = string
  sensitive = true
  default   = null
}

variable "fcm_service_account_json" {
  type      = string
  sensitive = true
  default   = null
}

# ---- Secrets rotation ----
variable "jwt_rotation_lambda_arn" {
  description = "ARN of the Lambda that performs JWT key-pair rotation, if deployed."
  type        = string
  default     = null
}

# ---- CDN signed URLs ----
variable "cdn_public_key_pem" {
  description = "Public key (PEM) matching CDN_PRIVATE_KEY, used to create signed delivery URLs."
  type        = string
  default     = null
}

# ---- GitHub OIDC ----
variable "github_org" {
  type    = string
  default = "classroom-platform"
}

variable "github_repo" {
  type    = string
  default = "classroom-app"
}

# ---- Budgets ----
variable "monthly_budget_usd" {
  type    = number
  default = 500
}

variable "budget_alert_email" {
  type    = string
  default = null
}