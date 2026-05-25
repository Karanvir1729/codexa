terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_security_group" "vllm" {
  name        = "${var.name}-vllm"
  description = "vLLM OpenAI-compatible API"
  vpc_id      = var.vpc_id

  ingress {
    description = "OpenAI-compatible vLLM"
    from_port   = 5000
    to_port     = 5000
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  user_data = templatefile("${path.module}/../../scripts/aws_vllm_user_data.sh", {
    HF_TOKEN             = var.hf_token
    MODEL_ID             = var.model_id
    SERVED_MODEL_NAME    = var.served_model_name
    TENSOR_PARALLEL_SIZE = var.tensor_parallel_size
    MAX_MODEL_LEN        = var.max_model_len
  })
}

resource "aws_instance" "vllm" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.vllm.id]
  associate_public_ip_address = true
  user_data                   = local.user_data

  root_block_device {
    volume_size = 500
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.name}-vllm"
  }
}

