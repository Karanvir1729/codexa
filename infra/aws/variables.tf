variable "aws_region" {
  description = "AWS region for the GPU host."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "voice-agent"
}

variable "vpc_id" {
  description = "Existing VPC ID."
  type        = string
}

variable "subnet_id" {
  description = "Public or routed subnet ID for the GPU instance."
  type        = string
}

variable "key_name" {
  description = "EC2 key pair name for emergency SSH access."
  type        = string
}

variable "allowed_cidr" {
  description = "CIDR allowed to reach the vLLM API. Use a private CIDR or VPN range in production."
  type        = string
}

variable "ami_id" {
  description = "Deep Learning AMI with NVIDIA drivers."
  type        = string
}

variable "instance_type" {
  description = "GPU instance type. g5.xlarge is the credit-safe default. p5.48xlarge is appropriate for multi-GPU 49B/120B testing."
  type        = string
  default     = "g5.xlarge"
}

variable "hf_token" {
  description = "Hugging Face token if the selected model requires gated access."
  type        = string
  sensitive   = true
  default     = ""
}

variable "model_id" {
  description = "Hugging Face model ID for vLLM."
  type        = string
  default     = "nvidia/Llama-3.1-Nemotron-Nano-8B-v1"
}

variable "served_model_name" {
  description = "OpenAI-compatible served model name."
  type        = string
  default     = "Llama-3.1-Nemotron-Nano-8B-v1"
}

variable "tensor_parallel_size" {
  description = "Number of GPUs used by vLLM tensor parallelism."
  type        = number
  default     = 1
}

variable "max_model_len" {
  description = "Max context length exposed by vLLM."
  type        = number
  default     = 8192
}
