environment        = "dev"
aws_region         = "eu-central-1"
domain_name        = "dev.classroom.app"
vpc_cidr           = "10.10.0.0/16"
az_count           = 2
single_nat_gateway = true # one shared NAT — cost over HA in dev