@ECHO OFF

FOR /f "tokens=1*delims==" %%a IN (.env) DO (
SET %%a=%%b
)