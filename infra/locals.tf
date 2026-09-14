/**
 * infra/locals.tf [UNCHANGED]
 * Naming convention: every resource name is prefixed "classroom-<env>-".
 */

locals {
  name_prefix = "classroom-${var.environment}"

  common_tags = {
    Project     = "classroom-platform"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}