@echo off
rem One command for the local dev stack: `dev`, `dev down`, `dev status`. See tools\dev\dev-up.mjs.
node "%~dp0tools\dev\dev-up.mjs" %*
