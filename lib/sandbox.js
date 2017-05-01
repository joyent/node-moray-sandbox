/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Library for standing up temporary Moray instances.
 *
 * To stand up a new Moray instance, we go through the following steps:
 *
 * 1. Initialize a new DB directory w/ initdb.
 * 2. Start Postgres listening on a Unix socket.
 * 3. Create a new DB to back our Moray instance.
 * 4. Start the Moray server in standalone mode (no Manatee).
 * 5. Set up the "buckets_config" table in our new DB.
 */

'use strict';

var mod_forkexec = require('forkexec');
var mod_fs = require('fs');
var mod_moray_server = require('moray-server');
var mod_util = require('util');
var mod_vasync = require('vasync');
var VError = require('verror');


// --- Globals

var BIND_IP = '127.0.0.1';

var PG_CONFIG = [
    'listen_addresses = \'\'',
    'fsync = off',
    'synchronous_commit = off',
    'full_page_writes = off'
].join('\n');

var mkTableSQL = 'CREATE TABLE IF NOT EXISTS buckets_config ( ' +
    'name text PRIMARY KEY, ' +
    'index text NOT NULL, ' +
    'pre text NOT NULL, ' +
    'post text NOT NULL, ' +
    'options text, ' +
    'mtime timestamp without time zone DEFAULT now() NOT NULL' +
');';


// --- Internal

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
}


function mkMorayConfig(log, connstr) {
    var morayPort = getRandomInt(2000, 10000);
    return {
        server: {
            log: log,
            name: 'moray-sandbox',
            port: morayPort,
            bindip: BIND_IP,
            audit: false,
            standalone: {
                pg: {
                    maxConnections: 5,
                    queryTimeout: 30000
                },
                url: connstr
            }
        },
        client: {
            host: BIND_IP,
            port: morayPort
        }
    };
}


function MoraySandbox(log, baseDir, cleanup) {
    this.log      = log;
    this.baseDir  = baseDir;
    this.dbDir    = mod_util.format('%s/db', baseDir);
    this.unixDir  = mod_util.format('%s/unix', baseDir);
    this._cleanup = cleanup;
    this.stopping = false;
    this.pg_child = null;
    this.servers  = [];

    Object.seal(this);
}


MoraySandbox.prototype._initDB = function initDB(callback) {
    var self = this;
    var args = [ 'initdb', '-D', self.dbDir, '-E', 'UNICODE', '-A', 'trust' ];
    self.log.info({ cmd: 'initdb', argv: args }, 'Executing command');
    mod_forkexec.forkExecWait({ argv: args }, function (err, info) {
        self.log.info(info, 'Finished initdb');
        if (err) {
            callback(err);
            return;
        }

        var cfg = mod_util.format('%s/postgresql.conf', self.dbDir);
        mod_fs.appendFile(cfg, PG_CONFIG, function (fErr) {
            if (fErr) {
                callback(new VError(fErr, 'Failed to append to PG config'));
                return;
            }

            mod_fs.mkdir(self.unixDir, function (mErr) {
                if (mErr) {
                    callback(new VError(mErr,
                        'Failed to create directory for Unix sockets'));
                    return;
                }

                callback();
            });
        });
    });
};


MoraySandbox.prototype._startPG = function startPG(callback) {
    var self = this;
    var args = [ 'postgres', '-D', self.dbDir, '-k', self.unixDir ];
    self.log.info({ cmd: 'postgres', argv: args }, 'Executing command');
    self.pg_child = mod_forkexec.forkExecWait({ argv: args },
        function (err, info) {
        if (err) {
            self.log.error(info, 'Postgres exited with an error');
        } else {
            self.log.info(info, 'Postgres exited non-fatally');
        }
        self._cleanup();
    });
    callback();
};


MoraySandbox.prototype._createDB = function createDB(req_id, callback) {
    var self = this;
    var attempt = 1;
    var args = [ 'createdb', '-E', 'UNICODE', '-h', self.unixDir, req_id ];
    function retry() {
        self.log.info({ cmd: 'createdb', argv: args }, 'Executing command');
        self.pg_child = mod_forkexec.forkExecWait({ argv: args },
            function (err, info) {
            if (err) {
                if (attempt < 5) {
                    // If PG is slow to start, createdb will fail the first time
                    self.log.error(info,
                        'Failed to create moray database; retrying');
                    attempt += 1;
                    retry();
                    return;
                } else {
                    self.log.error(info,
                        'Failed to create moray database; aborting');
                }
            }
            callback(err, self.unixDir + ' ' + req_id);
        });
    }

    retry();
};


MoraySandbox.prototype._startMoray = function startMoray(connstr, callback) {
    var self = this;
    var config = mkMorayConfig(self.log, connstr);
    var server = mod_moray_server.createServer(config.server);

    server.on('error', function onError(err) {
        callback(new VError(err, 'Failed to start Moray server'));
    });

    server.on('ready', function setupDB() {
        server.db_conn.pg(function (cErr, pg) {
            if (cErr) {
                callback(cErr);
                return;
            }

            var q = pg.query(mkTableSQL);

            q.once('error', function (err) {
                self.log.error(err, 'Error setting up database and tables');
                pg.release();
                callback(err);
            });

            q.once('end', function () {
                self.log.info('Database and tables ready');
                pg.release();
                callback(null, config.client);
            });
        });
    });
    server.listen();
    self.servers.push(server);
};


MoraySandbox.prototype.stop = function stopAll() {
    var self = this;
    if (self.stopping) {
        return;
    }

    self.stopping = true;

    function killPostgres() {
        self.log.info('Killing off Postgres children');

        // Send SIGTERM to process group.
        process.kill(-process.pid, 'SIGTERM');

        // Give Postgres time to shut down before removing its files.
        setTimeout(self._cleanup, 5000);
    }

    if (self.pg_child !== null) {
        mod_vasync.forEachParallel({
            'inputs': self.servers,
            'func': function (server, cb) {
                server.on('close', cb);
                server.close();
            }
        }, killPostgres);
    } else {
        self._cleanup();
    }
};


module.exports = MoraySandbox;