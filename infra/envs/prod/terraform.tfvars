environment        = "prod"
aws_region         = "eu-central-1"
domain_name        = "classroom.app"
vpc_cidr           = "10.30.0.0/16"
az_count           = 2
single_nat_gateway = false # one NAT gateway per AZ — an AZ outage must not take egress with it