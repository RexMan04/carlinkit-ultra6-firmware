#!/bin/sh
# The stock installer is not reachable directly on project firmware: use the
# main page's Install firmware button (cpthru_update.cgi checks and locks).
printf 'Content-Type: text/plain\n\nrefused: use Install firmware on the adapter main page (fail)\n'
