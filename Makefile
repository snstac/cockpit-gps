# Cockpit GPS — build and install.
#
# Quick start:
#   make                     # build the plugin into dist/ (fetches pkg/lib, npm install)
#   sudo make install        # install plugin system-wide (/usr/share/cockpit/gps)
#   sudo make install-integrity   # also install the spoof/jam monitor service
#   make devel-install       # symlink dist/ into ~/.local/share/cockpit for development
#   make watch               # rebuild on change

PACKAGE_NAME := gps
PREFIX ?= /usr
DESTDIR ?=
APPSTREAMFILE = org.snstac.gps.metainfo.xml

# stamp file to check for node_modules/
NODE_MODULES_TEST = package-lock.json
# build.js ran in non-watch mode
DIST_TEST = runtime-npm-modules.txt
# one example file in pkg/lib to check if it was already checked out
COCKPIT_REPO_STAMP = pkg/lib/cockpit-po-plugin.js

all: $(DIST_TEST)

#
# Cockpit build helpers (pkg/lib) are vendored from the Cockpit repo at a pinned
# commit. No API stability guarantee; bump occasionally.
#
COCKPIT_REPO_FILES = pkg/lib
COCKPIT_REPO_URL = https://github.com/cockpit-project/cockpit.git
COCKPIT_REPO_COMMIT = 9a575701943c91cc02460343e4d19cac1bee5f56 # 362 + 25 commits

$(COCKPIT_REPO_FILES): $(COCKPIT_REPO_STAMP)
COCKPIT_REPO_TREE = '$(strip $(COCKPIT_REPO_COMMIT))^{tree}'
$(COCKPIT_REPO_STAMP): Makefile
	@git rev-list --quiet --objects $(COCKPIT_REPO_TREE) -- 2>/dev/null || \
	    git fetch --no-tags --no-write-fetch-head --depth=1 $(COCKPIT_REPO_URL) $(COCKPIT_REPO_COMMIT)
	git archive $(COCKPIT_REPO_TREE) -- $(COCKPIT_REPO_FILES) | tar x

#
# i18n
#
LINGUAS = $(basename $(notdir $(wildcard po/*.po)))

po/$(PACKAGE_NAME).js.pot:
	xgettext --default-domain=$(PACKAGE_NAME) --output=- --language=C --keyword= \
		--add-comments=Translators: \
		--keyword=_:1,1t --keyword=_:1c,2,2t --keyword=C_:1c,2 \
		--keyword=N_ --keyword=NC_:1c,2 \
		--keyword=gettext:1,1t --keyword=gettext:1c,2,2t \
		--keyword=ngettext:1,2,3t --keyword=ngettext:1c,2,3,4t \
		--from-code=UTF-8 $$(find src/ -name '*.[jt]s' -o -name '*.[jt]sx') | \
		sed '/^#/ s/, c-format//' > $@

po/$(PACKAGE_NAME).manifest.pot: $(COCKPIT_REPO_STAMP)
	pkg/lib/manifest2po -o $@ src/manifest.json

po/LINGUAS:
	echo $(LINGUAS) | tr ' ' '\n' > $@

#
# Build / install
#
$(DIST_TEST): $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP) $(shell find src/ -type f) package.json build.js
	NODE_ENV=$(NODE_ENV) ./build.js

watch: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	NODE_ENV=$(NODE_ENV) ./build.js --watch

COCKPITDIR = $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)

install: $(DIST_TEST) po/LINGUAS
	mkdir -p $(COCKPITDIR)
	cp -r dist/* $(COCKPITDIR)
	mkdir -p $(DESTDIR)$(PREFIX)/share/metainfo/
	msgfmt --xml -d po --template $(APPSTREAMFILE) \
		-o $(DESTDIR)$(PREFIX)/share/metainfo/$(APPSTREAMFILE) 2>/dev/null || \
		cp $(APPSTREAMFILE) $(DESTDIR)$(PREFIX)/share/metainfo/$(APPSTREAMFILE)
	@echo "Installed plugin -> $(COCKPITDIR)"

uninstall:
	rm -rf $(COCKPITDIR)
	rm -f $(DESTDIR)$(PREFIX)/share/metainfo/$(APPSTREAMFILE)

# Optional spoof/jam integrity monitor (systemd service).
install-integrity:
	install -D -m 0755 integrity/gps-integrity $(DESTDIR)/usr/local/bin/gps-integrity
	install -D -m 0644 integrity/gps-integrity.service $(DESTDIR)/etc/systemd/system/gps-integrity.service
	install -D -m 0644 integrity/gps-integrity.conf.example $(DESTDIR)/etc/gps-integrity.conf.example
	@echo "Installed integrity monitor. Enable with: systemctl enable --now gps-integrity.service"

uninstall-integrity:
	-systemctl disable --now gps-integrity.service 2>/dev/null || true
	rm -f $(DESTDIR)/usr/local/bin/gps-integrity $(DESTDIR)/etc/systemd/system/gps-integrity.service

# Development: symlink the built tree into the per-user cockpit dir (no root).
devel-install: $(DIST_TEST)
	mkdir -p ~/.local/share/cockpit
	ln -sfn `pwd`/dist ~/.local/share/cockpit/$(PACKAGE_NAME)

devel-uninstall:
	rm -f ~/.local/share/cockpit/$(PACKAGE_NAME)

clean:
	rm -rf dist/
	rm -f po/LINGUAS metafile.json runtime-npm-modules.txt

$(NODE_MODULES_TEST): package.json
	rm -f package-lock.json
	for _ in `seq 3`; do timeout 10m env -u NODE_ENV npm install --ignore-scripts && exit 0; done; exit 1
	env -u NODE_ENV npm prune

.PHONY: all watch install uninstall install-integrity uninstall-integrity devel-install devel-uninstall clean
