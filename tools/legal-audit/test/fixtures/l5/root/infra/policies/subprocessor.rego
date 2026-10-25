package recon.subprocessor

# Reads the annotation; a reference, not an annotation.
deny[msg] {
  name := input.metadata.annotations["recon.core829.eu/subprocessor"]
  not known(name)
  msg := sprintf("unknown sub-processor %v", [name])
}
