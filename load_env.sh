#!/bin/bash
while read line; do export "$line";
done <source .env