{{/* Names */}}
{{- define "recon.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Region guard: data residency is not a free-form value. */}}
{{- define "recon.region" -}}
{{- if ne (toString .Values.region) "eu" -}}
{{- fail (printf "values.region must be \"eu\" (R-PRIV-4), got %q" (toString .Values.region)) -}}
{{- end -}}
{{- .Values.region -}}
{{- end -}}

{{/* Selector labels: dict "root" . "component" "api" */}}
{{- define "recon.selectorLabels" -}}
app.kubernetes.io/name: {{ default .root.Chart.Name .root.Values.nameOverride }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Common labels: dict "root" . "component" "api" */}}
{{- define "recon.labels" -}}
{{ include "recon.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: recon
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" | quote }}
recon.core829.eu/region: {{ include "recon.region" .root | quote }}
{{- end -}}

{{/* Image reference: dict "root" . "image" <values image block> ; repository is relative to image.registry unless it contains a "/" host part. */}}
{{- define "recon.image" -}}
{{- $tag := default .root.Chart.AppVersion .image.tag | toString -}}
{{- if eq $tag "latest" -}}
{{- fail "image tag \"latest\" is not allowed" -}}
{{- end -}}
{{- $ref := printf "%s/%s:%s" .root.Values.image.registry .image.repository $tag -}}
{{- if .image.digest -}}
{{- $ref = printf "%s@%s" $ref .image.digest -}}
{{- end -}}
{{- $ref -}}
{{- end -}}

{{/* Hardened pod-level securityContext. */}}
{{- define "recon.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Hardened container-level securityContext. */}}
{{- define "recon.containerSecurityContext" -}}
allowPrivilegeEscalation: false
privileged: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
capabilities:
  drop:
    - ALL
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* imagePullSecrets */}}
{{- define "recon.pullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* DB connection query: always verify-full against the mounted CA (R-SEC-1). dict "caPath" "…" */}}
{{- define "recon.dbParams" -}}
sslmode=verify-full&sslrootcert={{ .caPath }}
{{- end -}}

{{/* Zone + node topology spread, hard on zone (Architecture §8). dict "root" . "component" "api" "spread" <values> */}}
{{- define "recon.topologySpread" -}}
topologySpreadConstraints:
  - maxSkew: {{ .spread.zoneMaxSkew }}
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        {{- include "recon.selectorLabels" . | nindent 8 }}
  - maxSkew: {{ .spread.nodeMaxSkew }}
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "recon.selectorLabels" . | nindent 8 }}
{{- end -}}
