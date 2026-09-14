environment        = "staging"
aws_region         = "eu-central-1"
domain_name        = "staging.classroom.app"
vpc_cidr           = "10.20.0.0/16"
az_count           = 2
single_nat_gateway = true # mirrors prod topology closely enough for smoke tests, still cost-optimised