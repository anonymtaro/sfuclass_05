/**
 * infra/providers.tf [EXT] renamed from porviders.tf
 * Two provider instances: the primary region everything else lives in, and a
 * fixed us-east-1 alias that exists only because CloudFront requires its
 * certificate to be issued there regardless of where the app itself runs.
 */

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# Used exclusively by acm.tf for the CloudFront-facing certificate (cdn / media).
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}

# Used exclusively by backup.tf for the cross-region snapshot copy target.
provider "aws" {
  alias  = "dr_region"
  region = var.backup_region

  default_tags {
    tags = local.common_tags
  }
}